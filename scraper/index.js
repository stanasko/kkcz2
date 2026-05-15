#!/usr/bin/env node
// BR Stats Scraper — replicates BRScraper v2 logic for GitHub Actions
// Reads data/scraped.json (known match IDs) → fetches new finished matches
// → aggregates player stats → writes data/stats.json + data/scraped.json

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT    = path.join(__dirname, '..', 'data');

const TOKEN  = process.env.BR_TOKEN;
const SEASON = parseInt(process.env.BR_SEASON || '65', 10);

if (!TOKEN) { console.error('BR_TOKEN env var missing'); process.exit(1); }

// Per-season directory, e.g. data/s65/
const SEASON_DIR = path.join(DATA_ROOT, `s${SEASON}`);

const BASE_URL  = 'https://basketballrivals.net/api';
const DELAY_MS  = 650;
const HEADERS   = {
  'Accept':            'application/json',
  'Authorization':     `Bearer ${TOKEN}`,
  'x-client-platform': 'ios',
  'x-client-version':  '1.88.846',
  'User-Agent':        'basketballrivals/846 CFNetwork/3826.600.41 Darwin/24.6.0',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(path) {
  await delay(DELAY_MS);
  const res = await fetch(`${BASE_URL}/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return res.json();
}

function readSeasonJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(SEASON_DIR, file), 'utf8')); }
  catch { return fallback; }
}

function writeSeasonJson(file, data) {
  fs.mkdirSync(SEASON_DIR, { recursive: true });
  fs.writeFileSync(path.join(SEASON_DIR, file), JSON.stringify(data, null, 2));
}

function updateSeasonsMeta() {
  // Detect every s{N} folder under data/ and write seasons.json
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const available = fs.readdirSync(DATA_ROOT)
    .map(name => /^s(\d+)$/.exec(name))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10))
    .sort((a, b) => a - b);
  const meta = { current: SEASON, available };
  fs.writeFileSync(path.join(DATA_ROOT, 'seasons.json'), JSON.stringify(meta, null, 2));
}

// ── Extract match list from various API response shapes ───────────────────────

function extractMatches(data) {
  const entries = [];
  if (data.matchdays) {
    for (const md of data.matchdays)
      for (const m of (md.matches || []))
        entries.push({ id: m.id, finished: m.finished, date: m.startAt?.datetime?.slice(0,10) ?? null });
    return entries;
  }
  if (data.groups?.rounds)
    for (const r of data.groups.rounds)
      for (const m of (r.matches || []))
        entries.push({ id: m.id, finished: m.finished, date: m.startAt?.datetime?.slice(0,10) ?? null });
  if (data.rounds)
    for (const r of data.rounds)
      for (const m of (r.matches || []))
        entries.push({ id: m.id, finished: m.finished, date: m.startAt?.datetime?.slice(0,10) ?? null });
  return entries;
}

// ── Aggregate player stats into the stats object ──────────────────────────────

function getOrCreateTeam(stats, teamInfo) {
  let team = stats.teams.find(t => t.id === teamInfo.id);
  if (!team) {
    team = {
      id:   teamInfo.id,
      name: teamInfo.name,
      flag: teamInfo.flag ?? null,
      players: [],
    };
    stats.teams.push(team);
  } else {
    // keep name/flag updated
    team.name = teamInfo.name;
    if (teamInfo.flag) team.flag = teamInfo.flag;
  }
  return team;
}

function getOrCreatePlayer(team, userInfo) {
  let p = team.players.find(p => p.user_id === userInfo.id);
  if (!p) {
    p = {
      user_id:          userInfo.id,
      username:         userInfo.player_username ?? userInfo.playerUsername ?? String(userInfo.id),
      flag:             userInfo.flag ?? null,
      level:            userInfo.level ?? 0,
      total_possession: 0,
      play_count:       0,
      match_count:      0,
      total_points:     0,
      total_shots:      0,
      mvp_count:        0,
      by_competition:   [],
      by_match:         [],
    };
    team.players.push(p);
  }
  return p;
}

function getOrCreateCompStat(player, compId) {
  let c = player.by_competition.find(c => c.competition_id === compId);
  if (!c) {
    c = { competition_id: compId, total_possession: 0, play_count: 0, match_count: 0, total_points: 0, total_shots: 0, mvp_count: 0 };
    player.by_competition.push(c);
  }
  return c;
}

// ── Process one match ─────────────────────────────────────────────────────────

async function processMatch(stats, matchId, compId, compName, compType) {
  console.log(`  Match ${matchId} (${compName})…`);

  // Ensure competition is registered
  if (!stats.competitions.find(c => c.id === compId))
    stats.competitions.push({ id: compId, name: compName, type: compType });

  // Fetch match detail
  let detail;
  try { detail = await apiGet(`matches/${matchId}`); }
  catch (e) { console.warn(`    ⚠ match detail failed: ${e.message}`); return; }

  const matchInfo = detail.match;
  const plays     = detail.matchPlays ?? [];
  const matchDate = matchInfo?.startAt?.datetime?.slice(0, 10) ?? null;

  const homeTeamInfo = matchInfo?.homeTeam;
  const awayTeamInfo = matchInfo?.awayTeam;
  if (!homeTeamInfo || !awayTeamInfo) { console.warn(`    ⚠ missing team info`); return; }

  const homeTeam = getOrCreateTeam(stats, homeTeamInfo);
  const awayTeam = getOrCreateTeam(stats, awayTeamInfo);

  // Per-play: accumulate possession per player (all ranking players, not just top-2)
  // Key: `${teamId}:${userId}` → { possession, plays, isFirstPlay }
  const matchAcc = {}; // accumulator across all plays for this match

  function accumulate(teamId, userInfo, possession) {
    const key = `${teamId}:${userInfo.id}`;
    if (!matchAcc[key]) matchAcc[key] = { teamId, userInfo, possession: 0, plays: 0 };
    matchAcc[key].possession += possession;
    matchAcc[key].plays      += 1;
  }

  for (const play of plays) {
    // Fetch individual play endpoint (has ALL ranking players with possession)
    let playDetail = null;
    try {
      const pd = await apiGet(`matches/${matchId}/play/${play.id}`);
      playDetail = pd.matchPlay ?? null;
    } catch (e) {
      console.warn(`    ⚠ play ${play.id} fetch failed: ${e.message}`);
    }

    const homeRankings = playDetail?.rankings?.home ?? [];
    const awayRankings = playDetail?.rankings?.away ?? [];

    // Seed with top-2 from main endpoint (in case play endpoint fails)
    const seededHomeIds = new Set();
    const seededAwayIds = new Set();

    for (const pp of (play.homePlayers ?? [])) {
      accumulate(homeTeamInfo.id, pp.user, pp.possession ?? 0);
      seededHomeIds.add(pp.user.id);
    }
    for (const pp of (play.awayPlayers ?? [])) {
      accumulate(awayTeamInfo.id, pp.user, pp.possession ?? 0);
      seededAwayIds.add(pp.user.id);
    }

    // Add ALL ranking players (dedup against already-seeded)
    for (const rp of homeRankings) {
      if (!seededHomeIds.has(rp.user.id))
        accumulate(homeTeamInfo.id, rp.user, rp.possession ?? 0);
    }
    for (const rp of awayRankings) {
      if (!seededAwayIds.has(rp.user.id))
        accumulate(awayTeamInfo.id, rp.user, rp.possession ?? 0);
    }
  }

  // Determine MVP per side (top possession player)
  // MVP = player with highest possession on the winning side (or home if draw)
  // Simple heuristic: highest possession on each side gets mvp flag for the match
  const homeEntries = Object.values(matchAcc).filter(e => e.teamId === homeTeamInfo.id);
  const awayEntries = Object.values(matchAcc).filter(e => e.teamId === awayTeamInfo.id);

  const homeMvpId = homeEntries.sort((a,b) => b.possession - a.possession)[0]?.userInfo?.id ?? null;
  const awayMvpId = awayEntries.sort((a,b) => b.possession - a.possession)[0]?.userInfo?.id ?? null;

  // Write accumulated data into stats
  for (const { teamId, userInfo, possession, plays: playsCount } of Object.values(matchAcc)) {
    const team   = teamId === homeTeamInfo.id ? homeTeam : awayTeam;
    const player = getOrCreatePlayer(team, userInfo);
    const compSt = getOrCreateCompStat(player, compId);
    const isMvp  = userInfo.id === homeMvpId || userInfo.id === awayMvpId;

    // Totals
    player.total_possession += possession;
    player.play_count       += playsCount;
    player.match_count      += 1;
    if (isMvp) player.mvp_count += 1;

    // By competition
    compSt.total_possession += possession;
    compSt.play_count       += playsCount;
    compSt.match_count      += 1;
    if (isMvp) compSt.mvp_count += 1;

    // By match (for progression chart)
    player.by_match.push({
      match_id:        matchId,
      date:            matchDate,
      competition_id:  compId,
      opponent_team_id: teamId === homeTeamInfo.id ? awayTeamInfo.id : homeTeamInfo.id,
      possession,
      plays:           playsCount,
      points:          0, // throws data not aggregated per-player here (available in DB)
      is_mvp:          isMvp,
    });
  }

  // Throws: accumulate points & shots per player
  for (const play of plays) {
    for (const throwData of (play.throws ?? [])) {
      const uid = throwData.user?.id;
      if (!uid) continue;
      const pts = (throwData.points ?? []).reduce((a, b) => a + b, 0);
      const shots = (throwData.points ?? []).length;
      // find which team this player is on
      const isHome = (play.homePlayers ?? []).some(pp => pp.user?.id === uid) ||
                     (play.rankings?.home ?? []).includes(uid);
      const team = isHome ? homeTeam : awayTeam;
      const p = team.players.find(p => p.user_id === uid);
      if (p) {
        p.total_points += pts;
        p.total_shots  += shots;
        const cs = p.by_competition.find(c => c.competition_id === compId);
        if (cs) { cs.total_points += pts; cs.total_shots += shots; }
        const bm = p.by_match.find(bm => bm.match_id === matchId);
        if (bm) { bm.points += pts; }
      }
    }
  }

  console.log(`    ✓ ${Object.keys(matchAcc).length} player-play records`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏀 BR Stats Scraper — Season ${SEASON}`);
  console.log('═'.repeat(50));

  // Load persistent state
  const scraped = new Set(readSeasonJson('scraped.json', []));
  const stats   = readSeasonJson('stats.json', {
    season: SEASON,
    last_updated: null,
    competitions: [],
    teams: [],
  });
  stats.season = SEASON;

  // Fetch competitions
  console.log('\n📡 Fetching competitions…');
  let compsData;
  try { compsData = await apiGet('competitions'); }
  catch (e) { console.error(`Cannot fetch competitions: ${e.message}`); process.exit(1); }

  const active = (compsData.competitions ?? []).filter(c =>
    c.id !== 0 &&
    c.type !== 5 &&
    !c.name.toLowerCase().includes('training')
  );
  console.log(`   Found ${active.length} active competitions`);

  // Collect unscraped finished matches
  const workList = []; // { comp, matchId, date }

  for (const comp of active) {
    console.log(`\n📋 Scanning ${comp.name}…`);
    let matchData;
    try { matchData = await apiGet(`competitions/${comp.id}/matches`); }
    catch (e) { console.warn(`   ⚠ Cannot fetch matches: ${e.message}`); continue; }

    const entries = extractMatches(matchData);
    const newOnes = entries.filter(e => e.finished && !scraped.has(e.id));
    console.log(`   ${entries.length} total, ${newOnes.length} new`);
    for (const e of newOnes)
      workList.push({ comp, matchId: e.id, date: e.date });
  }

  if (workList.length === 0) {
    console.log('\n✅ Nothing new to scrape.');
  } else {
    console.log(`\n⚙ Processing ${workList.length} matches…\n`);
    for (const { comp, matchId } of workList) {
      await processMatch(stats, matchId, comp.id, comp.name, comp.type);
      scraped.add(matchId);
      // Save after each match (safe checkpointing)
      stats.last_updated = new Date().toISOString();
      writeSeasonJson('stats.json',   stats);
      writeSeasonJson('scraped.json', [...scraped]);
    }
  }

  stats.last_updated = new Date().toISOString();
  writeSeasonJson('stats.json',   stats);
  writeSeasonJson('scraped.json', [...scraped]);
  updateSeasonsMeta();

  const totalPlayers = stats.teams.reduce((s, t) => s + t.players.length, 0);
  console.log(`\n🏆 Done! ${stats.teams.length} teams, ${totalPlayers} players, ${scraped.size} matches in DB`);
  console.log(`📁 data/s${SEASON}/stats.json updated (${new Date().toLocaleString()})`);
}

main().catch(e => { console.error(e); process.exit(1); });
