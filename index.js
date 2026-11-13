
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import config from './config.js';
import {
  registerInternationalCommands,
  checkInternationalScores,
  fetchInternationalLiveMatches
} from './international.js';

// --------------------------------------------------
// ENVIRONMENT CHECK
// --------------------------------------------------

for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID']) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true
});

registerInternationalCommands(bot);

const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const POLL_INTERVAL = config.pollInterval || 60_000;
const WEBSITE = config.website || 'https://livehdmatches.netlify.app';

// English Championship added: eng.2
const LEAGUES = (
  process.env.ESPN_LEAGUES ||
  'eng.1,eng.2,esp.1,ger.1,ita.1,fra.1,usa.1,uefa.champions'
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

let previousMatches = new Map();
let latestMatches = [];
let firstCheck = true;
let checking = false;

const notifiedEvents = new Set();
const upcomingNotified = new Set();

const LINE = '━━━━━━━━━━━━━━━━━━';
const BRAND = '⚡ <b>𝗙𝗢𝗢𝗧𝗕𝗔𝗟𝗟 𝗟𝗜𝗩𝗘 𝗛𝗗 𝗣𝗥𝗢</b>';

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function footer() {
  return [
    LINE,
    `🌐 <a href="${escapeHtml(WEBSITE)}">𝗩𝗜𝗦𝗜𝗧 𝗢𝗨𝗥 𝗪𝗘𝗕𝗦𝗜𝗧𝗘</a>`,
    '⚽ 𝗟𝗜𝗩𝗘 • 𝗙𝗔𝗦𝗧 • 𝗙𝗢𝗢𝗧𝗕𝗔𝗟𝗟'
  ].join('\n');
}

function premiumMessage(title, body = '') {
  return [
    BRAND,
    LINE,
    title ? `<b>${title}</b>` : '',
    body,
    footer()
  ].filter(Boolean).join('\n\n');
}

function isLive(status) {
  return ['IN_PLAY', 'HT', 'ET', 'PEN'].includes(status);
}

function formatDateForESPN(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}${month}${day}`;
}

// --------------------------------------------------
// ESPN MATCH STATUS
// --------------------------------------------------

function normalizeStatus(event) {
  const status = event.status || {};
  const type = status.type || {};
  const name = String(type.name || '').toUpperCase();
  const state = String(type.state || '').toLowerCase();

  if (name.includes('PENALTY')) return 'PEN';
  if (name.includes('OVERTIME')) return 'ET';
  if (name.includes('HALFTIME')) return 'HT';

  if (name.includes('FINAL') || name.includes('FULL_TIME')) {
    return 'FINISHED';
  }

  if (state === 'post') return 'FINISHED';
  if (state === 'pre') return 'SCHEDULED';
  if (state === 'in') return 'IN_PLAY';

  return 'UNKNOWN';
}

// --------------------------------------------------
// NORMALIZE ESPN MATCHES
// --------------------------------------------------

function normalizeMatch(event, competition, league) {
  const competitors = event.competitions?.[0]?.competitors || [];

  const home = competitors.find(team => team.homeAway === 'home');
  const away = competitors.find(team => team.homeAway === 'away');

  if (
    !event.id ||
    !home?.team?.displayName ||
    !away?.team?.displayName
  ) {
    return null;
  }

  const homeScore = Number.parseInt(home.score ?? '0', 10);
  const awayScore = Number.parseInt(away.score ?? '0', 10);

  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
    return null;
  }

  const status = event.status || {};

  return {
    id: String(event.id),
    league,
    homeTeam: home.team.displayName,
    awayTeam: away.team.displayName,
    homeTeamId: String(home.team.id || ''),
    awayTeamId: String(away.team.id || ''),
    homeScore,
    awayScore,
    status: normalizeStatus(event),
    minute: status.displayClock || status.type?.shortDetail || null,
    competition,
    kickoff: event.date || null,
    details: event.competitions?.[0]?.details || []
  };
}

// --------------------------------------------------
// FETCH MATCHES FROM ESPN
// --------------------------------------------------

async function fetchLeague(league, date = formatDateForESPN(new Date())) {
  const url = new URL(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/' +
    `${encodeURIComponent(league)}/scoreboard`
  );

  url.searchParams.set('dates', date);
  url.searchParams.set('limit', '100');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`${league}: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.events)) {
    throw new Error(`${league}: unexpected ESPN response`);
  }

  const competition = data.leagues?.[0]?.name || league;

  const matches = data.events
    .map(event => normalizeMatch(event, competition, league))
    .filter(Boolean);

  console.log(
    `[ESPN] ${league}: ${matches.length} matches loaded (${date})`
  );

  return matches;
}

async function fetchMatches() {
  const results = await Promise.allSettled(
    LEAGUES.map(league => fetchLeague(league))
  );

  const matches = [];
  let successfulLeagues = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (result.status === 'fulfilled') {
      successfulLeagues++;
      matches.push(...result.value);
    } else {
      console.error(
        `[ESPN] ${LEAGUES[i]} failed: ${
          result.reason?.message || result.reason
        }`
      );
    }
  }

  if (successfulLeagues === 0) {
    throw new Error('All ESPN requests failed. Check the league errors above.');
  }

  return [
    ...new Map(matches.map(match => [match.id, match])).values()
  ];
}

// --------------------------------------------------
// GOAL EVENT HELPERS
// --------------------------------------------------

function isGoalPlay(play) {
  const description = [
    play?.type?.text,
    play?.type?.name,
    play?.type?.description,
    play?.text,
    play?.shortText,
    play?.description,
    play?.headline,
    play?.playType?.text
  ].filter(Boolean).join(' ').toLowerCase();

  return (
    play?.scoringPlay === true ||
    play?.isGoal === true ||
    /\b(goal|penalty scored|own goal)\b/i.test(description)
  );
}

function extractGoalInfo(play) {
  const participants = [
    ...(Array.isArray(play?.participants) ? play.participants : []),
    ...(Array.isArray(play?.athletes) ? play.athletes : []),
    ...(Array.isArray(play?.athletesInvolved) ? play.athletesInvolved : [])
  ];

  let scorer = '';

  for (const participant of participants) {
    const athlete = participant?.athlete || participant;
    const name =
      athlete?.displayName ||
      athlete?.fullName ||
      athlete?.name;

    if (name) {
      scorer = name;
      break;
    }
  }

  const minute =
    play?.clock?.displayValue ||
    play?.clock?.displayClock ||
    play?.time?.displayValue ||
    play?.displayClock ||
    play?.minute ||
    '';

  const teamId =
    play?.team?.id ||
    play?.teamId ||
    play?.competitor?.id ||
    '';

  return {
    scorer,
    minute: String(minute || ''),
    teamId: String(teamId || '')
  };
}

// --------------------------------------------------
// GOAL SCORER LOOKUP
// --------------------------------------------------

async function fetchGoalInfo(match, oldMatch) {
  const homeScored = match.homeScore > oldMatch.homeScore;
  const awayScored = match.awayScore > oldMatch.awayScore;

  const changedTeamId =
    homeScored && !awayScored
      ? match.homeTeamId
      : awayScored && !homeScored
        ? match.awayTeamId
        : '';

  let plays = Array.isArray(match.details)
    ? match.details.filter(isGoalPlay)
    : [];

  const hasUsefulMatchingGoal = () =>
    plays.map(extractGoalInfo).some(goal =>
      goal.scorer && (!changedTeamId || goal.teamId === changedTeamId)
    );

  if (!hasUsefulMatchingGoal() && match.league && match.id) {
    try {
      const url = new URL(
        'https://site.api.espn.com/apis/site/v2/sports/soccer/' +
        `${encodeURIComponent(match.league)}/summary`
      );

      url.searchParams.set('event', match.id);

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        const data = await response.json();

        const summaryPlays = [
          ...(Array.isArray(data.scoringPlays) ? data.scoringPlays : []),
          ...(Array.isArray(data.plays) ? data.plays.filter(isGoalPlay) : []),
          ...(Array.isArray(data.keyEvents) ? data.keyEvents.filter(isGoalPlay) : []),
          ...(Array.isArray(data.header?.competitions?.[0]?.details)
            ? data.header.competitions[0].details.filter(isGoalPlay)
            : [])
        ];

        if (summaryPlays.length) plays = summaryPlays;
      }
    } catch (error) {
      console.error(`[SCORER] ${match.id}: ${error.message}`);
    }
  }

  const goalPlays = plays
    .map(extractGoalInfo)
    .filter(goal => goal.scorer || goal.minute || goal.teamId);

  const matchingGoals = changedTeamId
    ? goalPlays.filter(goal => goal.teamId === changedTeamId)
    : [];

  const goal = matchingGoals.length
    ? matchingGoals[matchingGoals.length - 1]
    : goalPlays.length
      ? goalPlays[goalPlays.length - 1]
      : null;

  return {
    scorer: goal?.scorer || 'Scorer unavailable',
    minute: goal?.minute || match.minute || 'Minute unavailable'
  };
}

// --------------------------------------------------
// STARTING LINEUPS — RETRY UNTIL AVAILABLE
// --------------------------------------------------

function getPlayerName(player) {
  return (
    player?.athlete?.displayName ||
    player?.athlete?.fullName ||
    player?.player?.displayName ||
    player?.player?.fullName ||
    player?.displayName ||
    player?.fullName ||
    player?.name ||
    ''
  );
}

function getTeamId(node) {
  return String(
    node?.team?.id ||
    node?.teamId ||
    node?.competitor?.id ||
    node?.team?.uid?.split(':').pop() ||
    ''
  );
}

function extractStarters(data, teamId) {
  const players = new Map();
  const visited = new Set();

  function walk(node, inheritedTeam = '', inLineup = false) {
    if (!node || typeof node !== 'object') return;

    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, inheritedTeam, inLineup);
      }
      return;
    }

    const currentTeam = getTeamId(node) || inheritedTeam;

    const label = [
      node.type?.name,
      node.type?.text,
      node.name,
      node.displayName,
      node.title
    ].filter(Boolean).join(' ').toLowerCase();

    const lineupContext =
      inLineup ||
      /starting lineup|starting xi|starters|starting eleven/.test(label);

    const name = getPlayerName(node);

    const isStarter =
      node.starter === true ||
      node.isStarter === true ||
      node.starting === true ||
      node.isStarting === true ||
      node.type?.name?.toLowerCase() === 'starter';

    if (name && isStarter && currentTeam === String(teamId)) {
      players.set(name, name);
    }

    if (name && lineupContext && currentTeam === String(teamId)) {
      const hasPlayerIdentity =
        node.athlete ||
        node.player ||
        node.position ||
        node.jersey;

      if (hasPlayerIdentity) {
        players.set(name, name);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue;

      const childLabel = String(key).toLowerCase();
      const childIsLineup =
        lineupContext ||
        /lineup|starter|starting eleven|starting xi/.test(childLabel);

      walk(value, currentTeam, childIsLineup);
    }
  }

  walk(data);

  return [...players.values()];
}

async function fetchLineups(match) {
  if (!match.league || !match.id) return null;

  try {
    const url = new URL(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/' +
      `${encodeURIComponent(match.league)}/summary`
    );

    url.searchParams.set('event', match.id);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.log(`[LINEUP] ${match.id}: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    console.log(
      `[LINEUP] ${match.id}: sections = ` +
      Object.keys(data).join(', ')
    );

    const home = extractStarters(data, match.homeTeamId);
    const away = extractStarters(data, match.awayTeamId);

    if (!home.length || !away.length) {
      console.log(
        `[LINEUP] ${match.id}: awaiting both teams ` +
        `(home=${home.length}, away=${away.length})`
      );
      return null;
    }

    console.log(
      `[LINEUP] ${match.id}: found ${home.length} home, ` +
      `${away.length} away players`
    );

    return { home, away };
  } catch (error) {
    console.error(`[LINEUP] ${match.id}: ${error.message}`);
    return null;
  }
}

function formatLineup(teamName, players) {
  return [
    `👥 <b>${escapeHtml(teamName)}</b>`,
    ...players.map((player, index) =>
      `${index + 1}. ${escapeHtml(player)}`
    )
  ].join('\n');
}

async function sendLineupAlert(match) {
  const key = `lineup:${match.id}`;

  if (notifiedEvents.has(key)) return;

  const lineups = await fetchLineups(match);

  if (!lineups) return;

  const body = [
    '📋 <b>𝗢𝗙𝗙𝗜𝗖𝗜𝗔𝗟 𝗦𝗧𝗔𝗥𝗧𝗜𝗡𝗚 𝗟𝗜𝗡𝗘𝗨𝗣𝗦</b>',
    `🏆 <b>${escapeHtml(match.competition)}</b>`,
    `🔵 ${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}`,
    '',
    formatLineup(match.homeTeam, lineups.home),
    '',
    formatLineup(match.awayTeam, lineups.away)
  ].join('\n');

  await sendAlert(premiumMessage('', body), key);
}

// --------------------------------------------------
// TELEGRAM SENDING
// --------------------------------------------------

async function sendAlert(message, eventKey) {
  if (notifiedEvents.has(eventKey)) return false;

  try {
    await bot.sendMessage(CHANNEL_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    notifiedEvents.add(eventKey);
    console.log(`[ALERT] Sent: ${eventKey}`);

    if (notifiedEvents.size > 2000) {
      notifiedEvents.delete(notifiedEvents.values().next().value);
    }

    return true;
  } catch (error) {
    console.error(`[ALERT] ${error.message}`);
    return false;
  }
}

// --------------------------------------------------
// ZIMBABWE KICKOFF TIME
// --------------------------------------------------

function kickoffTime(match) {
  if (!match.kickoff) return 'Not available';

  const date = new Date(match.kickoff);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleString('en-GB', {
    timeZone: 'Africa/Harare',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }) + ' CAT';
}

// --------------------------------------------------
// 30-MINUTE PRE-KICKOFF REMINDERS
// --------------------------------------------------

async function sendUpcomingMatchAlert(match) {
  const settings = config.upcomingMatches;

  if (!settings?.enabled || !match.kickoff) return;
  if (match.status !== 'SCHEDULED') return;

  const kickoffMs = new Date(match.kickoff).getTime();
  if (!Number.isFinite(kickoffMs)) return;

  const minutesBefore = Number(settings.minutesBeforeKickoff ?? 30);
  const remainingMs = kickoffMs - Date.now();

  if (remainingMs > minutesBefore * 60_000 || remainingMs <= 0) {
    return;
  }

  const key = `upcoming:${match.id}`;
  if (upcomingNotified.has(key)) return;

  let lineups = null;

  if (settings.showLineups) {
    lineups = await fetchLineups(match);
  }

  const body = [
    '⏳ <b>𝗠𝗔𝗧𝗖𝗛 𝗞𝗜𝗖𝗞𝗜𝗡𝗚 𝗢𝗙𝗙 𝗦𝗢𝗢𝗡!</b>',

    settings.showCompetition
      ? `🏆 <b>${escapeHtml(match.competition)}</b>`
      : '',

    settings.showTeams
      ? `🔵 <b>${escapeHtml(match.homeTeam)}</b>\n` +
        '          <b>VS</b>\n' +
        `🔴 <b>${escapeHtml(match.awayTeam)}</b>`
      : '',

    settings.showKickoffTime
      ? `🕒 <b>KICK-OFF:</b> ${escapeHtml(kickoffTime(match))}`
      : '',

    settings.showLineups
      ? [
          '📋 <b>STARTING LINEUPS</b>',
          lineups
            ? formatLineup(match.homeTeam, lineups.home)
            : `👥 <b>${escapeHtml(match.homeTeam)}:</b> Lineup not available`,
          lineups
            ? formatLineup(match.awayTeam, lineups.away)
            : `👥 <b>${escapeHtml(match.awayTeam)}:</b> Lineup not available`
        ].join('\n\n')
      : ''
  ].filter(Boolean).join('\n\n');

  const sent = await sendAlert(premiumMessage('', body), key);

  if (sent) {
    upcomingNotified.add(key);
  }
}

// --------------------------------------------------
// FORMAT MATCH DETAILS
// --------------------------------------------------

function formatMatch(match, showCompetition = true) {
  const lines = [];

  if (showCompetition) {
    lines.push(`🏆 <b>${escapeHtml(match.competition)}</b>`);
  }

  lines.push(
    `🔵 <b>${escapeHtml(match.homeTeam)}</b>\n` +
    `       <b>${match.homeScore} - ${match.awayScore}</b>\n` +
    `🔴 <b>${escapeHtml(match.awayTeam)}</b>`
  );

  if (match.status === 'HT') {
    lines.push('⏸️ <b>HALF-TIME</b>');
  } else if (match.status === 'SCHEDULED') {
    lines.push(`🕒 <b>KICK-OFF:</b> ${escapeHtml(kickoffTime(match))}`);
  } else if (match.status === 'FINISHED') {
    lines.push('🏁 <b>FULL-TIME</b>');
  } else if (match.status === 'ET') {
    lines.push('⏱️ <b>EXTRA TIME</b>');
  } else if (match.status === 'PEN') {
    lines.push('🥅 <b>PENALTY SHOOTOUT</b>');
  } else if (isLive(match.status) && match.minute) {
    lines.push(`⏱️ <b>TIME:</b> ${escapeHtml(match.minute)}`);
  }

  return lines.join('\n\n');
}

// --------------------------------------------------
// GOAL ALERTS
// --------------------------------------------------

async function sendGoalAlert(match, oldMatch) {
  if (!config.goalAlerts?.enabled) return;

  const settings = config.goalAlerts;
  const goalInfo = await fetchGoalInfo(match, oldMatch);

  const eventKey =
    `goal:${match.id}:${match.homeScore}-${match.awayScore}`;

  const body = [
    `🚨 <b>𝗚𝗢𝗔𝗔𝗔𝗟! ${escapeHtml(settings.emoji || '⚽')}🔥</b>`,

    settings.showCompetition
      ? `🏆 <b>${escapeHtml(match.competition)}</b>`
      : '',

    settings.showTeams
      ? `🔵 <b>${escapeHtml(match.homeTeam)}</b>\n` +
        `       <b>${match.homeScore} ${escapeHtml(settings.scoreSeparator || '-')} ${match.awayScore}</b>\n` +
        `🔴 <b>${escapeHtml(match.awayTeam)}</b>`
      : '',

    settings.showScorer
      ? `⚽ <b>SCORER:</b> ${escapeHtml(goalInfo.scorer)}`
      : '',

    settings.showMinute
      ? `⏱️ <b>GOAL TIME:</b> ${escapeHtml(goalInfo.minute)}`
      : ''
  ].filter(Boolean).join('\n\n');

  await sendAlert(premiumMessage('', body), eventKey);
}

// --------------------------------------------------
// MATCH STATUS ALERTS
// --------------------------------------------------

async function sendStatusAlert(match, oldMatch) {
  const settings = config.matchAlerts;
  if (!settings?.enabled) return;

  const oldStatus = oldMatch.status;
  const status = match.status;

  const events = {
    'SCHEDULED>IN_PLAY': [
      settings.kickoff,
      '🟢',
      '𝗠𝗔𝗧𝗖𝗛 𝗞𝗜𝗖𝗞-𝗢𝗙𝗙'
    ],
    'IN_PLAY>HT': [
      settings.halfTime,
      '⏸️',
      '𝗛𝗔𝗟𝗙-𝗧𝗜𝗠𝗘'
    ],
    'IN_PLAY>FINISHED': [
      settings.fullTime,
      '🏁',
      '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    ],
    'HT>FINISHED': [
      settings.fullTime,
      '🏁',
      '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    ],
    'ET>FINISHED': [
      settings.fullTime,
      '🏁',
      '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    ],
    'HT>IN_PLAY': [
      settings.secondHalfKickoff,
      '▶️',
      '𝗦𝗘𝗖𝗢𝗡𝗗-𝗛𝗔𝗟𝗙 𝗞𝗜𝗖𝗞-𝗢𝗙𝗙'
    ],
    'IN_PLAY>ET': [
      settings.extraTime,
      '⏱️',
      '𝗘𝗫𝗧𝗥𝗔 𝗧𝗜𝗠𝗘'
    ],
    'ET>PEN': [
      settings.penalties,
      '🥅',
      '𝗣𝗘𝗡𝗔𝗟𝗧𝗬 𝗦𝗛𝗢𝗢𝗧𝗢𝗨𝗧'
    ]
  };

  const event = events[`${oldStatus}>${status}`];
  if (!event || !event[0]) return;

  const body = [
    `${event[1]} <b>${event[2]}</b>`,
    formatMatch(match)
  ].join('\n\n');

  await sendAlert(
    premiumMessage('', body),
    `status:${match.id}:${oldStatus}>${status}`
  );
}

// --------------------------------------------------
// CHECK SCORES AND DETECT CHANGES
// --------------------------------------------------

async function checkScores() {
  if (checking) return;
  checking = true;

  try {
    // International goal monitoring is separate from club alerts.
    // If international feeds fail, club monitoring still continues.
    try {
      await checkInternationalScores(bot, CHANNEL_ID);
    } catch (error) {
      console.error(`[INTERNATIONAL CHECK] ${error.message}`);
    }

    // Existing club match monitoring.
    const matches = await fetchMatches();
    const currentMatches = new Map();

    for (const match of matches) {
      currentMatches.set(match.id, match);

      await sendUpcomingMatchAlert(match);

      // Keep checking for lineups independently of reminders.
      if (match.status === 'SCHEDULED' || isLive(match.status)) {
        await sendLineupAlert(match);
      }

      const oldMatch = previousMatches.get(match.id);

      // Establish a baseline for newly discovered matches.
      if (!oldMatch) continue;

      const scoreChanged =
        match.homeScore > oldMatch.homeScore ||
        match.awayScore > oldMatch.awayScore;

      if (scoreChanged && isLive(match.status)) {
        await sendGoalAlert(match, oldMatch);
      }

      await sendStatusAlert(match, oldMatch);
    }

    previousMatches = currentMatches;
    latestMatches = matches;

    console.log(
      `[ESPN] Loaded ${matches.length} matches across ${LEAGUES.length} competitions`
    );

    if (firstCheck) {
      firstCheck = false;
      console.log('[ESPN] Initial baseline loaded; monitoring score changes.');
    }
  } catch (error) {
    console.error(`[CHECK] ${error.message}`);
  } finally {
    checking = false;
  }
}

// --------------------------------------------------
// /START
// --------------------------------------------------

bot.onText(/^\/start(?:@\w+)?(?:\s|$)/i, async msg => {
  const body = [
    '👋 Welcome to your live football update centre!',
    '⚽ Live scores and goal notifications',
    '🕒 Match kickoff times',
    '🏁 Full-time results',
    '',
    '📌 <b>COMMANDS</b>',
    '/live — Show live matches',
    '/upcoming — View upcoming fixtures',
    '/international — International fixtures and scores',
    '/help — Show all commands'
  ].join('\n');

  await bot.sendMessage(
    msg.chat.id,
    premiumMessage('𝗪𝗘𝗟𝗖𝗢𝗠𝗘', body),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }
  ).catch(error => console.error(`[START] ${error.message}`));
});

// --------------------------------------------------
// /UPCOMING
// --------------------------------------------------

bot.onText(/^\/upcoming(?:@\w+)?(?:\s|$)/i, async msg => {
  try {
    const matches = await fetchMatches();
    latestMatches = matches;

    const upcoming = matches
      .filter(match => {
        if (match.status !== 'SCHEDULED' || !match.kickoff) {
          return false;
        }

        const kickoff = new Date(match.kickoff).getTime();

        return Number.isFinite(kickoff) && kickoff > Date.now();
      })
      .sort((a, b) =>
        new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()
      )
      .slice(0, 20);

    if (!upcoming.length) {
      await bot.sendMessage(
        msg.chat.id,
        premiumMessage(
          '𝗨𝗣𝗖𝗢𝗠𝗜𝗡𝗚 𝗠𝗔𝗧𝗖𝗛𝗘𝗦',
          '📅 No upcoming fixtures were returned for the requested date. Try again later.'
        ),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
      return;
    }

    const body = [
      '📅 <b>𝗨𝗣𝗖𝗢𝗠𝗜𝗡𝗚 𝗠𝗔𝗧𝗖𝗛𝗘𝗦</b>',
      '',
      ...upcoming.map(match => [
        `🏆 <b>${escapeHtml(match.competition)}</b>`,
        `🔵 ${escapeHtml(match.homeTeam)}`,
        '⚔️ <b>VS</b>',
        `🔴 ${escapeHtml(match.awayTeam)}`,
        `🕒 <b>KICK-OFF:</b> ${escapeHtml(kickoffTime(match))}`
      ].join('\n'))
    ].join(`\n\n${LINE}\n\n`);

    await bot.sendMessage(
      msg.chat.id,
      premiumMessage('', body),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }
    );
  } catch (error) {
    console.error(`[UPCOMING] ${error.message}`);

    await bot.sendMessage(
      msg.chat.id,
      '⚠️ Could not load upcoming matches. Please try again.'
    ).catch(() => {});
  }
});


 // --------------------------------------------------
// /LIVE — CLUB + INTERNATIONAL MATCHES
// --------------------------------------------------

bot.onText(/^\/live(?:@\w+)?(?:\s|$)/i, async msg => {
  try {
    if (!config.liveMatches?.enabled) {
      await bot.sendMessage(
        msg.chat.id,
        'Live match display is disabled.'
      );
      return;
    }

    // Fetch club and international matches.
    const [clubMatches, internationalMatches] =
      await Promise.all([
        fetchMatches(),
        fetchInternationalLiveMatches()
      ]);

    latestMatches = clubMatches;

    // Combine both match lists.
    const allMatches = [
      ...clubMatches,
      ...internationalMatches
    ];

    // Remove duplicate events.
    const uniqueMatches = [
      ...new Map(
        allMatches.map(match => [String(match.id), match])
      ).values()
    ];

    // Keep live matches only.
    const liveMatches = uniqueMatches
      .filter(match => isLive(match.status))
      .sort((a, b) => {
        return new Date(a.kickoff || 0) -
          new Date(b.kickoff || 0);
      });

    if (!liveMatches.length) {
      await bot.sendMessage(
        msg.chat.id,
        premiumMessage(
          '🔴 LIVE MATCHES',
          '⚽ No live matches were returned by ESPN right now. Please try again later.'
        ),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
      return;
    }

    const maxResults = Math.max(
      1,
      Number(config.liveMatches.maxResults) || 25
    );

    const displayedMatches = liveMatches.slice(0, maxResults);

    const body = [
      '🔴 <b>𝗔𝗟𝗟 𝗟𝗜𝗩𝗘 𝗠𝗔𝗧𝗖𝗛𝗘𝗦</b>',
      `🌍 <b>TOTAL LIVE MATCHES: ${liveMatches.length}</b>`,
      ...displayedMatches.map(match => formatMatch(match))
    ].join(`\n\n${LINE}\n\n`);

    await bot.sendMessage(
      msg.chat.id,
      premiumMessage('', body),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }
    );

    console.log(
      `[LIVE COMMAND] ${liveMatches.length} live matches found ` +
      `(Club: ${clubMatches.filter(m => isLive(m.status)).length}, ` +
      `International: ${internationalMatches.length})`
    );

  } catch (error) {
    console.error(`[LIVE] ${error.message}`);

    await bot.sendMessage(
      msg.chat.id,
      '⚠️ Could not load live matches. Please try again.'
    ).catch(() => {});
  }
});

// --------------------------------------------------
// /HELP
// --------------------------------------------------

bot.onText(/^\/help(?:@\w+)?(?:\s|$)/i, async msg => {
  const body = [
    '📌 <b>𝗕𝗢𝗧 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
    '',
    '/start — Open the welcome message',
    '/live — View currently live matches',
    '/upcoming — View upcoming fixtures',
    '/international — View international fixtures and scores',
    '/help — Display this menu',
    '',
    '⚽ Automatic goal and match-status alerts',
    '🌍 Automatic international goal alerts',
    '🌐 Live football website:',
    `<a href="${escapeHtml(WEBSITE)}">${escapeHtml(WEBSITE)}</a>`
  ].join('\n');

  await bot.sendMessage(
    msg.chat.id,
    premiumMessage('𝗛𝗘𝗟𝗣', body),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }
  ).catch(error => console.error(`[HELP] ${error.message}`));
});

// --------------------------------------------------
// TELEGRAM ERRORS AND STARTUP
// --------------------------------------------------

bot.on('polling_error', error => {
  console.error(`[TELEGRAM] ${error.message}`);
});

console.log('⚽ Football Live HD PRO V2 starting...');
console.log(`[ESPN] Competitions: ${LEAGUES.join(', ')}`);
console.log(`[ESPN] Checking every ${POLL_INTERVAL / 1000} seconds.`);
console.log(
  `[UPCOMING] 30-minute reminders: ${
    config.upcomingMatches?.enabled ? 'enabled' : 'disabled'
  }`
);

console.log('[INTERNATIONAL] Automatic goal monitoring enabled.');

await checkScores();
setInterval(checkScores, POLL_INTERVAL);
