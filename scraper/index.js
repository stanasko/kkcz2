#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// BR Stats Scraper v3 — extended data: matches, standings, per-match details,
// shooting splits (2pt/3pt/miss), player level tracking, competition formats
// ═══════════════════════════════════════════════════════════════════════════

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, '..', 'data');

const TOKEN  = process.env.BR_TOKEN;
const SEASON = parseInt(process.env.BR_SEASON || '65', 10);
if (!TOKEN) { console.error('BR_TOKEN env var missing'); process.exit(1); }

const SEASON_DIR  = path.join(DATA_ROOT, `s${SEASON}`);
const MATCHES_DIR = path.join(SEASON_DIR, 'matches');

const BASE_URL = 'https://basketballrivals.net/api';
const DELAY_MS = 650;
const HEADERS  = {
  'Accept':            'application/json',
  'Authorization':     `Bearer ${TOKEN}`,
  'x-client-platform': 'ios',
  'x-client-version':  '1.88.846',
  'User-Agent':        'basketballrivals/846 CFNetwork/3826.600.41 Darwin/24.6.0',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(p) {
  await delay(DELAY_MS);
  const res = await fetch(`${BASE_URL}/${p}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`API ${res.status} for ${p}`);
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
function writeMatchDetail(matchId, data) {
  fs.mkdirSync(MATCHES_DIR, { recursive: true });
  fs.writeFileSync(path.join(MATCHES_DIR, `${matchId}.json`), JSON.stringify(data, null, 2));
}

function updateSeasonsMeta() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const available = fs.readdirSync(DATA_ROOT)
    .map(name => /^s(\d+)$/.exec(name))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10))
    .sort((a, b) => a - b);
  fs.writeFileSync(path.join(DATA_ROOT, 'seasons.json'),
    JSON.stringify({ current: SEASON, available }, null, 2));
}

// ── Extract matches & detect competition format ──────────────────────────────

function detectFormat(data) {
  if (data.matchdays && data.matchdays.length) return 'league';
  if (data.groups?.rounds && data.rounds) return 'groups+knockout';
  if (data.groups?.rounds) return 'groups';
  if (data.rounds) return 'knockout';
  return 'unknown';
}

function extractMatches(data) {
  // returns: [{ id, finished, date, matchday, round, group }]
  const entries = [];
  if (data.matchdays) {
    for (const md of data.matchdays)
      for (const m of (md.matches || []))
        entries.push({
          id: m.id, finished: m.finished,
          date: m.startAt?.datetime?.slice(0, 10) ?? null,
          matchday: md.number, round: null, group: null,
        });
  }
  if (data.groups?.rounds) {
    for (const r of data.groups.rounds) {
      for (const m of (r.matches || []))
        entries.push({
          id: m.id, finished: m.finished,
          date: m.startAt?.datetime?.slice(0, 10) ?? null,
          matchday: null, round: r.number ?? null, group: r.group ?? null,
        });
    }
  }
  if (data.rounds) {
    for (const r of data.rounds)
      for (const m of (r.matches || []))
        entries.push({
          id: m.id, finished: m.finished,
          date: m.startAt?.datetime?.slice(0, 10) ?? null,
          matchday: null, round: r.number ?? null, group: null,
        });
  }
  return entries;
}

// ── Helpers for player/team management ──────────────────────────────────────

function getOrCreateTeam(stats, teamInfo) {
  let team = stats.teams.find(t => t.id === teamInfo.id);
  if (!team) {
    team = { id: teamInfo.id, name: teamInfo.name, flag: teamInfo.flag ?? null, players: [] };
    stats.teams.push(team);
  } else {
    team.name = teamInfo.name;
    if (teamInfo.flag) team.flag = teamInfo.flag;
  }
  return team;
}

function getOrCreatePlayer(team, userInfo) {
  let p = team.players.find(x => x.user_id === userInfo.id);
  if (!p) {
    p = {
      user_id:          userInfo.id,
      username:         userInfo.player_username ?? userInfo.playerUsername ?? String(userInfo.id),
      flag:             userInfo.flag ?? null,
      level_first:      userInfo.level ?? 0,
      level_current:    userInfo.level ?? 0,
      total_possession: 0,
      play_count:       0,
      match_count:      0,
      total_points:     0,
      total_shots:      0,
      shots_2pt_made:   0,
      shots_3pt_made:   0,
      shots_missed:     0,
      mvp_count:        0,
      by_competition:   [],
      by_match:         [],
    };
    team.players.push(p);
  }
  return p;
}

function getOrCreateCompStat(player, compId) {
  let c = player.by_competition.find(x => x.competition_id === compId);
  if (!c) {
    c = {
      competition_id: compId,
      total_possession: 0, play_count: 0, match_count: 0,
      total_points: 0, total_shots: 0,
      shots_2pt_made: 0, shots_3pt_made: 0, shots_missed: 0,
      mvp_count: 0,
    };
    player.by_competition.push(c);
  }
  return c;
}

// ── Process one match ────────────────────────────────────────────────────────

async function processMatch(stats, matchEntry, comp) {
  const { id: matchId, date: listDate, matchday, round, group } = matchEntry;
  console.log(`  Match ${matchId} (${comp.name}${matchday ? ' · MD' + matchday : ''})…`);

  let detail;
  try { detail = await apiGet(`matches/${matchId}`); }
  catch (e) { console.warn(`    ⚠ match detail failed: ${e.message}`); return false; }

  const matchInfo = detail.match;
  const plays     = detail.matchPlays ?? [];
  const matchDate = matchInfo?.startAt?.datetime?.slice(0, 10) ?? listDate;

  const homeTeamInfo = matchInfo?.homeTeam;
  const awayTeamInfo = matchInfo?.awayTeam;
  if (!homeTeamInfo || !awayTeamInfo) { console.warn(`    ⚠ missing team info`); return false; }

  const homeTeam = getOrCreateTeam(stats, homeTeamInfo);
  const awayTeam = getOrCreateTeam(stats, awayTeamInfo);

  // ── Per-match detail file structure ────────────────────────────────────────
  const matchDetail = {
    id: matchId, date: matchDate, competition_id: comp.id,
    competition_name: comp.name, matchday, round, group,
    home_team: { id: homeTeamInfo.id, name: homeTeamInfo.name, flag: homeTeamInfo.flag ?? null,
                 team_level: homeTeamInfo.teamLevel ?? null },
    away_team: { id: awayTeamInfo.id, name: awayTeamInfo.name, flag: awayTeamInfo.flag ?? null,
                 team_level: awayTeamInfo.teamLevel ?? null },
    home_points: matchInfo.homePoints ?? 0,
    away_points: matchInfo.awayPoints ?? 0,
    play_length: matchInfo.playLength ?? null,
    mvp_home_user_id: null,
    mvp_away_user_id: null,
    plays: [],
  };

  // Per-play accumulators
  // Key: `${teamId}:${userId}` → { teamId, userInfo, possession, plays, throws_pts, throws_2pt, throws_3pt, throws_miss, totalShots }
  const matchAcc = {};
  function accumulate(teamId, userInfo, possession, level) {
    const key = `${teamId}:${userInfo.id}`;
    if (!matchAcc[key]) matchAcc[key] = {
      teamId, userInfo, level: level ?? userInfo.level ?? 0,
      possession: 0, plays: 0,
      throws_pts: 0, throws_2pt: 0, throws_3pt: 0, throws_miss: 0, totalShots: 0,
    };
    matchAcc[key].possession += possession;
    matchAcc[key].plays      += 1;
    if (level != null) matchAcc[key].level = Math.max(matchAcc[key].level, level);
  }

  // ── Process each play ────────────────────────────────────────────────────
  for (const play of plays) {
    let playDetail = null;
    try {
      const pd = await apiGet(`matches/${matchId}/play/${play.id}`);
      playDetail = pd.matchPlay ?? null;
    } catch (e) { console.warn(`    ⚠ play ${play.id} fetch failed: ${e.message}`); }

    const homeRankings = playDetail?.rankings?.home ?? [];
    const awayRankings = playDetail?.rankings?.away ?? [];

    // Seed top-2 from main endpoint
    const seededHomeIds = new Set();
    const seededAwayIds = new Set();
    for (const pp of (play.homePlayers ?? [])) {
      accumulate(homeTeamInfo.id, pp.user, pp.possession ?? 0, pp.user.level);
      seededHomeIds.add(pp.user.id);
    }
    for (const pp of (play.awayPlayers ?? [])) {
      accumulate(awayTeamInfo.id, pp.user, pp.possession ?? 0, pp.user.level);
      seededAwayIds.add(pp.user.id);
    }

    // Add ALL ranking players
    for (const rp of homeRankings) {
      if (!seededHomeIds.has(rp.user.id))
        accumulate(homeTeamInfo.id, rp.user, rp.possession ?? 0, rp.user.level);
    }
    for (const rp of awayRankings) {
      if (!seededAwayIds.has(rp.user.id))
        accumulate(awayTeamInfo.id, rp.user, rp.possession ?? 0, rp.user.level);
    }

    // ── Build per-play detail for matches/{id}.json ───────────────────────
    function buildPlayerSnapshot(side, rankingsList, mainList) {
      const seen = new Set();
      const out = [];
      // First add main players (those who have possession from main endpoint)
      for (const pp of (mainList ?? [])) {
        if (seen.has(pp.user.id)) continue;
        seen.add(pp.user.id);
        out.push({
          user_id:    pp.user.id,
          username:   pp.user.player_username ?? pp.user.playerUsername ?? String(pp.user.id),
          flag:       pp.user.flag ?? null,
          level:      pp.user.level ?? 0,
          possession: pp.possession ?? 0,
          is_main:    !!pp.is_main_player || !!pp.isMainPlayer,
        });
      }
      // Then ranking players not yet added
      for (const rp of (rankingsList ?? [])) {
        if (seen.has(rp.user.id)) continue;
        seen.add(rp.user.id);
        out.push({
          user_id:    rp.user.id,
          username:   rp.user.player_username ?? rp.user.playerUsername ?? String(rp.user.id),
          flag:       rp.user.flag ?? null,
          level:      rp.user.level ?? 0,
          possession: rp.possession ?? 0,
          is_main:    false,
        });
      }
      return out.sort((a, b) => b.possession - a.possession);
    }

    // Build throws breakdown for this play
    const throwsArr = [];
    for (const t of (play.throws ?? [])) {
      const uid    = t.user?.id; if (!uid) continue;
      const points = t.points ?? [];
      const made2  = points.filter(p => p === 2).length;
      const made3  = points.filter(p => p === 3).length;
      const miss   = points.filter(p => p === 0).length;
      const total  = points.reduce((s, x) => s + x, 0);
      throwsArr.push({
        user_id:    uid,
        username:   t.user.player_username ?? t.user.playerUsername ?? String(uid),
        flag:       t.user.flag ?? null,
        points:     points,
        total_points: total,
        shots_total: points.length,
        shots_2pt_made: made2,
        shots_3pt_made: made3,
        shots_missed:   miss,
      });

      // Determine team side & accumulate shooting stats
      const accKeyHome = `${homeTeamInfo.id}:${uid}`;
      const accKeyAway = `${awayTeamInfo.id}:${uid}`;
      const acc = matchAcc[accKeyHome] || matchAcc[accKeyAway];
      if (acc) {
        acc.throws_pts  += total;
        acc.throws_2pt  += made2;
        acc.throws_3pt  += made3;
        acc.throws_miss += miss;
        acc.totalShots  += points.length;
      }
    }

    matchDetail.plays.push({
      number: play.number,
      home_possession: play.home_possession ?? play.homePossession ?? 0,
      away_possession: play.away_possession ?? play.awayPossession ?? 0,
      number_of_throws: play.number_of_throws ?? play.numberOfThrows ?? 0,
      home_players: buildPlayerSnapshot('home', homeRankings, play.homePlayers),
      away_players: buildPlayerSnapshot('away', awayRankings, play.awayPlayers),
      throws: throwsArr,
    });
  }

  // ── Determine MVP per side (top possession on each team) ───────────────────
  const homeAcc = Object.values(matchAcc).filter(e => e.teamId === homeTeamInfo.id);
  const awayAcc = Object.values(matchAcc).filter(e => e.teamId === awayTeamInfo.id);
  const homeMvp = homeAcc.sort((a, b) => b.possession - a.possession)[0]?.userInfo?.id ?? null;
  const awayMvp = awayAcc.sort((a, b) => b.possession - a.possession)[0]?.userInfo?.id ?? null;
  matchDetail.mvp_home_user_id = homeMvp;
  matchDetail.mvp_away_user_id = awayMvp;

  const homePts = matchDetail.home_points, awayPts = matchDetail.away_points;
  const winnerTeamId = homePts > awayPts ? homeTeamInfo.id : (awayPts > homePts ? awayTeamInfo.id : null);

  // ── Write per-match detail file ────────────────────────────────────────────
  writeMatchDetail(matchId, matchDetail);

  // ── Aggregate into stats.json ──────────────────────────────────────────────
  // Match summary
  const existingMatchIdx = stats.matches.findIndex(m => m.id === matchId);
  const matchSummary = {
    id: matchId, date: matchDate, competition_id: comp.id,
    matchday, round, group,
    home_team_id: homeTeamInfo.id, away_team_id: awayTeamInfo.id,
    home_points: homePts, away_points: awayPts,
    mvp_home_user_id: homeMvp, mvp_away_user_id: awayMvp,
    winner_team_id: winnerTeamId, play_count: plays.length,
  };
  if (existingMatchIdx >= 0) stats.matches[existingMatchIdx] = matchSummary;
  else                       stats.matches.push(matchSummary);

  // Player aggregation
  for (const entry of Object.values(matchAcc)) {
    const team   = entry.teamId === homeTeamInfo.id ? homeTeam : awayTeam;
    const player = getOrCreatePlayer(team, entry.userInfo);
    const compSt = getOrCreateCompStat(player, comp.id);
    const isMvp  = entry.userInfo.id === homeMvp || entry.userInfo.id === awayMvp;
    const teamWon = winnerTeamId === entry.teamId;

    // Level tracking
    if (entry.level > 0) {
      if (!player.level_first || entry.level < player.level_first) player.level_first = entry.level;
      if (entry.level > player.level_current) player.level_current = entry.level;
    }

    // Totals
    player.total_possession += entry.possession;
    player.play_count       += entry.plays;
    player.match_count      += 1;
    player.total_points     += entry.throws_pts;
    player.total_shots      += entry.totalShots;
    player.shots_2pt_made   += entry.throws_2pt;
    player.shots_3pt_made   += entry.throws_3pt;
    player.shots_missed     += entry.throws_miss;
    if (isMvp) player.mvp_count += 1;

    // By competition
    compSt.total_possession += entry.possession;
    compSt.play_count       += entry.plays;
    compSt.match_count      += 1;
    compSt.total_points     += entry.throws_pts;
    compSt.total_shots      += entry.totalShots;
    compSt.shots_2pt_made   += entry.throws_2pt;
    compSt.shots_3pt_made   += entry.throws_3pt;
    compSt.shots_missed     += entry.throws_miss;
    if (isMvp) compSt.mvp_count += 1;

    // By match (avoid dup if reprocessing)
    const bmIdx = player.by_match.findIndex(b => b.match_id === matchId);
    const bm = {
      match_id: matchId, date: matchDate, competition_id: comp.id,
      opponent_team_id: entry.teamId === homeTeamInfo.id ? awayTeamInfo.id : homeTeamInfo.id,
      matchday, round, group,
      possession: entry.possession, plays: entry.plays,
      points: entry.throws_pts, shots: entry.totalShots,
      shots_2pt_made: entry.throws_2pt, shots_3pt_made: entry.throws_3pt, shots_missed: entry.throws_miss,
      level: entry.level,
      is_mvp: isMvp, team_won: teamWon,
      team_id: entry.teamId,
      home_points: homePts, away_points: awayPts,
      home_team_id: homeTeamInfo.id, away_team_id: awayTeamInfo.id,
    };
    if (bmIdx >= 0) player.by_match[bmIdx] = bm;
    else            player.by_match.push(bm);
  }

  console.log(`    ✓ ${plays.length} plays · ${Object.keys(matchAcc).length} player records · ${homePts}:${awayPts}`);
  return true;
}

// ── Compute standings per competition ───────────────────────────────────────

function computeStandings(stats) {
  const standings = {};
  for (const comp of stats.competitions) {
    const compMatches = stats.matches.filter(m => m.competition_id === comp.id);
    const byTeam = new Map(); // teamId → {wins, losses, pf, pa, matches}
    for (const m of compMatches) {
      if (m.home_points == null || m.away_points == null) continue;
      const homeWon = m.home_points > m.away_points;
      const awayWon = m.away_points > m.home_points;

      for (const [teamId, mine, theirs, won] of [
        [m.home_team_id, m.home_points, m.away_points, homeWon],
        [m.away_team_id, m.away_points, m.home_points, awayWon],
      ]) {
        if (!byTeam.has(teamId)) byTeam.set(teamId, { wins: 0, losses: 0, pf: 0, pa: 0, matches: 0 });
        const r = byTeam.get(teamId);
        r.matches += 1;
        r.pf      += mine;
        r.pa      += theirs;
        if (won)             r.wins   += 1;
        else if (theirs > mine) r.losses += 1;
        // draws (rare): no W, no L
      }
    }

    const rows = [];
    for (const [teamId, r] of byTeam.entries()) {
      const team = stats.teams.find(t => t.id === teamId);
      rows.push({
        team_id: teamId,
        team_name: team?.name ?? `Team ${teamId}`,
        team_flag: team?.flag ?? null,
        wins: r.wins, losses: r.losses,
        win_pct: r.matches > 0 ? r.wins / r.matches : 0,
        points_for: r.pf, points_against: r.pa,
        matches_played: r.matches,
      });
    }
    rows.sort((a, b) =>
      b.wins - a.wins ||
      b.win_pct - a.win_pct ||
      b.points_for - a.points_for
    );
    standings[comp.id] = rows;
  }
  stats.standings = standings;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏀 BR Stats Scraper v3 — Season ${SEASON}`);
  console.log('═'.repeat(56));

  const scraped = new Set(readSeasonJson('scraped.json', []));
  const stats   = readSeasonJson('stats.json', null);

  // Reset stats if outdated structure (missing matches[] or standings)
  let s = stats;
  if (!s || !Array.isArray(s.matches) || !s.standings) {
    console.log('⚠ Existing data has old schema or missing — resetting.\n');
    s = { season: SEASON, last_updated: null, competitions: [], standings: {}, matches: [], teams: [] };
    scraped.clear();
  } else {
    s.season = SEASON;
  }

  // Step 1: competitions
  console.log('📡 Fetching competitions…');
  let compsData;
  try { compsData = await apiGet('competitions'); }
  catch (e) { console.error(`Cannot fetch competitions: ${e.message}`); process.exit(1); }

  const active = (compsData.competitions ?? []).filter(c =>
    c.id !== 0 && c.type !== 5 && !c.name.toLowerCase().includes('training')
  );
  console.log(`   Found ${active.length} active competitions\n`);

  // Step 2: gather work list AND detect format per competition
  const workList = []; // { entry, comp }

  for (const comp of active) {
    let matchData;
    try { matchData = await apiGet(`competitions/${comp.id}/matches`); }
    catch (e) { console.warn(`   ⚠ ${comp.name}: ${e.message}`); continue; }

    const format = detectFormat(matchData);
    console.log(`📋 ${comp.name} [${format}]`);

    // Upsert competition into stats
    let cm = s.competitions.find(c => c.id === comp.id);
    if (!cm) {
      cm = { id: comp.id, name: comp.name, type: comp.type, format };
      s.competitions.push(cm);
    } else {
      cm.name = comp.name; cm.type = comp.type; cm.format = format;
    }

    const entries = extractMatches(matchData);
    const newOnes = entries.filter(e => e.finished && !scraped.has(e.id));
    console.log(`   ${entries.length} total · ${newOnes.length} new`);
    for (const e of newOnes) workList.push({ entry: e, comp });
  }

  // Step 3: process
  if (workList.length === 0) {
    console.log('\n✅ Nothing new to scrape.');
  } else {
    console.log(`\n⚙ Processing ${workList.length} matches…\n`);
    let n = 0;
    for (const { entry, comp } of workList) {
      n++;
      const ok = await processMatch(s, entry, comp);
      if (ok) scraped.add(entry.id);
      // Periodic save (every 5 matches) to limit data loss on crash
      if (n % 5 === 0) {
        s.last_updated = new Date().toISOString();
        computeStandings(s);
        writeSeasonJson('stats.json',   s);
        writeSeasonJson('scraped.json', [...scraped]);
      }
    }
  }

  // Final
  computeStandings(s);
  s.last_updated = new Date().toISOString();
  writeSeasonJson('stats.json',   s);
  writeSeasonJson('scraped.json', [...scraped]);
  updateSeasonsMeta();

  const totalPlayers = s.teams.reduce((x, t) => x + t.players.length, 0);
  console.log(`\n🏆 Done! ${s.teams.length} teams · ${totalPlayers} players · ${s.matches.length} matches`);
  console.log(`📁 data/s${SEASON}/ updated · ${new Date().toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
