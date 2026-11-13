
import config from './config.js';

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer';

const TIME_ZONE = 'Africa/Harare';

const INTERNATIONAL_LEAGUES = [
  'uefa.nations',
  'uefa.w.nations',
  'fifa.worldq.uefa',
  'fifa.worldq.caf',
  'fifa.worldq.afc',
  'fifa.worldq.concacaf',
  'fifa.worldq.conmebol',
  'fifa.worldq.ofc',
  'fifa.friendly',
  'fifa.friendly.w'
];

const previousInternationalMatches = new Map();

const notifiedInternationalGoals = new Set();
const notifiedInternationalStatuses = new Set();
const notifiedInternationalLineups = new Set();
const notifiedInternationalUpcoming = new Set();

const lastInternationalLineupCheck = new Map();

const LINEUP_RETRY_INTERVAL = 5 * 60 * 1000;
const DEFAULT_UPCOMING_MINUTES = 30;

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

function trimSet(set, maximum = 2000) {
  while (set.size > maximum) {
    set.delete(set.values().next().value);
  }
}

function getCATDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}${values.month}${values.day}`;
}

function formatDate(dateValue) {
  if (!dateValue) return 'Date unavailable';

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }

  return date.toLocaleDateString('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function formatKickoff(dateValue) {
  if (!dateValue) return 'Time unavailable';

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return 'Time unavailable';
  }

  return date.toLocaleString('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }) + ' CAT';
}

function getStatus(event) {
  const type = event.status?.type || {};
  const name = String(type.name || '').toUpperCase();
  const state = String(type.state || '').toLowerCase();

  if (name.includes('HALFTIME')) return 'HT';
  if (
    name.includes('PENALTY') ||
    name.includes('SHOOTOUT')
  ) return 'PEN';

  if (
    name.includes('OVERTIME') ||
    name.includes('EXTRA TIME')
  ) return 'ET';

  if (
    name.includes('FINAL') ||
    name.includes('FULL_TIME')
  ) return 'FINISHED';

  if (state === 'in') return 'IN_PLAY';
  if (state === 'post') return 'FINISHED';
  if (state === 'pre') return 'SCHEDULED';

  return 'UNKNOWN';
}

function isLive(status) {
  return ['IN_PLAY', 'HT', 'ET', 'PEN'].includes(status);
}

// --------------------------------------------------
// MATCH NORMALIZATION
// --------------------------------------------------

function normalizeInternationalMatch(
  event,
  league,
  competition
) {
  const competitors =
    event.competitions?.[0]?.competitors || [];

  const home = competitors.find(
    team => team.homeAway === 'home'
  );

  const away = competitors.find(
    team => team.homeAway === 'away'
  );

  if (
    !event.id ||
    !home?.team?.displayName ||
    !away?.team?.displayName
  ) {
    return null;
  }

  const homeScore = Number.parseInt(
    home.score ?? '0',
    10
  );

  const awayScore = Number.parseInt(
    away.score ?? '0',
    10
  );

  if (
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore)
  ) {
    return null;
  }

  return {
    id: String(event.id),
    league,
    competition,

    homeTeam: home.team.displayName,
    awayTeam: away.team.displayName,

    homeTeamId: String(home.team.id || ''),
    awayTeamId: String(away.team.id || ''),

    homeScore,
    awayScore,

    status: getStatus(event),

    minute:
      event.status?.displayClock ||
      event.status?.type?.shortDetail ||
      '',

    kickoff: event.date || null,

    details:
      event.competitions?.[0]?.details || []
  };
}

// --------------------------------------------------
// FETCH INTERNATIONAL FIXTURES
// --------------------------------------------------

async function fetchInternationalLeague(league) {
  const url = new URL(
    `${ESPN_BASE}/${encodeURIComponent(league)}/scoreboard`
  );

  url.searchParams.set('dates', getCATDate());
  url.searchParams.set('limit', '100');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `${league}: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.events)) {
    throw new Error(`${league}: invalid ESPN response`);
  }

  const competition =
    data.leagues?.[0]?.name || league;

  const matches = data.events
    .map(event =>
      normalizeInternationalMatch(
        event,
        league,
        competition
      )
    )
    .filter(Boolean);

  console.log(
    `[INTERNATIONAL ESPN] ${league}: ${matches.length} matches`
  );

  return matches;
}

async function fetchInternationalMatches() {
  const results = await Promise.allSettled(
    INTERNATIONAL_LEAGUES.map(fetchInternationalLeague)
  );

  const matches = [];
  const successfulLeagues = new Set();

  results.forEach((result, index) => {
    const league = INTERNATIONAL_LEAGUES[index];

    if (result.status === 'fulfilled') {
      successfulLeagues.add(league);
      matches.push(...result.value);
    } else {
      console.error(
        `[INTERNATIONAL ESPN] ${league}: ${
          result.reason?.message || result.reason
        }`
      );
    }
  });

  if (successfulLeagues.size === 0) {
    throw new Error(
      'All international ESPN feeds failed.'
    );
  }

  return { matches, successfulLeagues };
}

// --------------------------------------------------
// GOALSCORER DETECTION
// --------------------------------------------------

function isGoalPlay(play) {
  const description = [
    play?.type?.text,
    play?.type?.name,
    play?.text,
    play?.shortText,
    play?.description,
    play?.headline
  ].filter(Boolean).join(' ').toLowerCase();

  return (
    play?.scoringPlay === true ||
    play?.isGoal === true ||
    /\b(goal|penalty scored|own goal)\b/i.test(description)
  );
}

function extractGoal(play) {
  const participants = [
    ...(Array.isArray(play?.participants)
      ? play.participants : []),

    ...(Array.isArray(play?.athletes)
      ? play.athletes : []),

    ...(Array.isArray(play?.athletesInvolved)
      ? play.athletesInvolved : [])
  ];

  let scorer = '';

  for (const participant of participants) {
    const athlete =
      participant?.athlete || participant;

    scorer =
      athlete?.displayName ||
      athlete?.fullName ||
      athlete?.name ||
      '';

    if (scorer) break;
  }

  return {
    scorer,

    minute:
      play?.clock?.displayValue ||
      play?.clock?.displayClock ||
      play?.time?.displayValue ||
      play?.displayClock ||
      play?.minute ||
      '',

    teamId: String(
      play?.team?.id ||
      play?.teamId ||
      play?.competitor?.id ||
      ''
    )
  };
}

async function fetchInternationalGoalInfo(
  match,
  oldMatch
) {
  const homeScored =
    match.homeScore > oldMatch.homeScore;

  const awayScored =
    match.awayScore > oldMatch.awayScore;

  const changedTeamId =
    homeScored && !awayScored
      ? match.homeTeamId
      : awayScored && !homeScored
        ? match.awayTeamId
        : '';

  let plays = Array.isArray(match.details)
    ? match.details.filter(isGoalPlay)
    : [];

  try {
    const url = new URL(
      `${ESPN_BASE}/${encodeURIComponent(match.league)}/summary`
    );

    url.searchParams.set('event', match.id);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      const data = await response.json();

      const summaryPlays = [
        ...(Array.isArray(data.scoringPlays)
          ? data.scoringPlays : []),

        ...(Array.isArray(data.plays)
          ? data.plays.filter(isGoalPlay) : []),

        ...(Array.isArray(data.keyEvents)
          ? data.keyEvents.filter(isGoalPlay) : [])
      ];

      if (summaryPlays.length) {
        plays = summaryPlays;
      }
    }
  } catch (error) {
    console.error(
      `[INTERNATIONAL SCORER] ${match.id}: ${error.message}`
    );
  }

  const goals = plays
    .map(extractGoal)
    .filter(goal =>
      goal.scorer || goal.minute || goal.teamId
    );

  const matching = changedTeamId
    ? goals.filter(
        goal => goal.teamId === changedTeamId
      )
    : goals;

  const goal = matching.at(-1) || goals.at(-1);

  return {
    scorer: goal?.scorer || 'Scorer unavailable',

    minute:
      goal?.minute ||
      match.minute ||
      'Minute unavailable'
  };
}

// --------------------------------------------------
// SEND INTERNATIONAL GOAL ALERT
// --------------------------------------------------

async function sendInternationalGoal(
  bot,
  channelId,
  match,
  oldMatch
) {
  const eventKey =
    `international:${match.id}:${match.homeScore}-${match.awayScore}`;

  if (notifiedInternationalGoals.has(eventKey)) {
    return true;
  }

  const goalInfo = await fetchInternationalGoalInfo(
    match,
    oldMatch
  );

  const website =
    String(config.website || '').trim();

  const body = [
    BRAND,
    LINE,
    '',
    '🚨 <b>𝗚𝗢𝗔𝗔𝗔𝗟! ⚽🔥</b>',
    '',
    `🏆 <b>${escapeHtml(match.competition)}</b>`,
    '',
    `🔵 <b>${escapeHtml(match.homeTeam)}</b>`,
    `       <b>${match.homeScore}  -  ${match.awayScore}</b>`,
    `🔴 <b>${escapeHtml(match.awayTeam)}</b>`,
    '',
    `⚽ <b>SCORER:</b> ${escapeHtml(goalInfo.scorer)}`,
    '',
    `⏱️ <b>GOAL TIME:</b> ${escapeHtml(goalInfo.minute)}`,
    '',
    LINE,
    '',
    '🌐 <b>𝗩𝗜𝗦𝗜𝗧 𝗢𝗨𝗥 𝗪𝗘𝗕𝗦𝗜𝗧𝗘</b>',
    website ? escapeHtml(website) : '',
    '⚽ <b>𝗟𝗜𝗩𝗘 • 𝗙𝗔𝗦𝗧 • 𝗙𝗢𝗢𝗧𝗕𝗔𝗟𝗟</b>'
  ].filter(line => line !== '').join('\n');

  try {
    await bot.sendMessage(channelId, body, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    notifiedInternationalGoals.add(eventKey);
    trimSet(notifiedInternationalGoals);

    console.log(
      `[INTERNATIONAL ALERT] Sent: ${eventKey}`
    );

    return true;

  } catch (error) {
    console.error(
      `[INTERNATIONAL ALERT] ${error.message}`
    );

    return false;
  }
}

// --------------------------------------------------
// INTERNATIONAL MATCH STATUS ALERTS
// --------------------------------------------------

async function sendInternationalStatusAlert(
  bot,
  channelId,
  match,
  oldMatch
) {
  const transition =
    `${oldMatch.status}>${match.status}`;

  const settings = config.matchAlerts || {};

  const transitions = {
    'SCHEDULED>IN_PLAY': {
      enabled: settings.kickoff,
      emoji: '🟢',
      title: '𝗠𝗔𝗧𝗖𝗛 𝗞𝗜𝗖𝗞-𝗢𝗙𝗙'
    },

    'IN_PLAY>HT': {
      enabled: settings.halfTime,
      emoji: '⏸️',
      title: '𝗛𝗔𝗟𝗙-𝗧𝗜𝗠𝗘'
    },

    'HT>IN_PLAY': {
      enabled: settings.secondHalfKickoff,
      emoji: '▶️',
      title: '𝗦𝗘𝗖𝗢𝗡𝗗-𝗛𝗔𝗟𝗙 𝗞𝗜𝗖𝗞-𝗢𝗙𝗙'
    },

    'IN_PLAY>ET': {
      enabled: settings.extraTime,
      emoji: '⏱️',
      title: '𝗘𝗫𝗧𝗥𝗔 𝗧𝗜𝗠𝗘'
    },

    'ET>PEN': {
      enabled: settings.penalties,
      emoji: '🥅',
      title: '𝗣𝗘𝗡𝗔𝗟𝗧𝗬 𝗦𝗛𝗢𝗢𝗧𝗢𝗨𝗧'
    },

    'IN_PLAY>FINISHED': {
      enabled: settings.fullTime,
      emoji: '🏁',
      title: '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    },

    'HT>FINISHED': {
      enabled: settings.fullTime,
      emoji: '🏁',
      title: '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    },

    'ET>FINISHED': {
      enabled: settings.fullTime,
      emoji: '🏁',
      title: '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    },

    'PEN>FINISHED': {
      enabled: settings.fullTime,
      emoji: '🏁',
      title: '𝗙𝗨𝗟𝗟-𝗧𝗜𝗠𝗘'
    }
  };

  const alert = transitions[transition];

  if (!alert || !config.matchAlerts?.enabled) {
    return true;
  }

  if (alert.enabled === false) {
    return true;
  }

  const eventKey =
    `international-status:${match.id}:${transition}`;

  if (notifiedInternationalStatuses.has(eventKey)) {
    return true;
  }

  const message = [
    `🌍 <b>INTERNATIONAL MATCH UPDATE</b>`,
    `${alert.emoji} <b>${alert.title}</b>`,
    `🏆 <b>${escapeHtml(match.competition)}</b>`,
    `🔵 <b>${escapeHtml(match.homeTeam)}</b>`,
    `       <b>${match.homeScore} - ${match.awayScore}</b>`,
    `🔴 <b>${escapeHtml(match.awayTeam)}</b>`,
    LINE,
    BRAND
  ].join('\n\n');

  try {
    await bot.sendMessage(channelId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    notifiedInternationalStatuses.add(eventKey);
    trimSet(notifiedInternationalStatuses);

    console.log(
      `[INTERNATIONAL STATUS] Sent: ${transition} ${match.id}`
    );

    return true;

  } catch (error) {
    console.error(
      `[INTERNATIONAL STATUS] ${error.message}`
    );

    return false;
  }
}

// --------------------------------------------------
// INTERNATIONAL UPCOMING MATCH REMINDERS
// --------------------------------------------------

async function sendInternationalUpcomingAlert(
  bot,
  channelId,
  match
) {
  if (!config.upcomingMatches?.enabled) {
    return true;
  }

  if (
    match.status !== 'SCHEDULED' ||
    !match.kickoff
  ) {
    return true;
  }

  const kickoffTime = new Date(match.kickoff).getTime();

  if (!Number.isFinite(kickoffTime)) {
    return true;
  }

  const now = Date.now();

  const reminderMinutes =
    Number(config.upcomingMatches.reminderMinutes) ||
    Number(config.upcomingMatches.minutesBefore) ||
    DEFAULT_UPCOMING_MINUTES;

  const timeUntilKickoff = kickoffTime - now;

  if (
    timeUntilKickoff <= 0 ||
    timeUntilKickoff > reminderMinutes * 60 * 1000
  ) {
    return true;
  }

  const eventKey =
    `international-upcoming:${match.id}`;

  if (notifiedInternationalUpcoming.has(eventKey)) {
    return true;
  }

  const message = [
    '🌍 <b>INTERNATIONAL MATCH REMINDER</b>',
    '🔔 <b>MATCH KICKING OFF SOON!</b>',
    `🏆 <b>${escapeHtml(match.competition)}</b>`,
    `🔵 <b>${escapeHtml(match.homeTeam)}</b>`,
    '⚔️ <b>VS</b>',
    `🔴 <b>${escapeHtml(match.awayTeam)}</b>`,
    `🕒 <b>KICK-OFF:</b> ${escapeHtml(formatKickoff(match.kickoff))}`,
    LINE,
    BRAND
  ].join('\n\n');

  try {
    await bot.sendMessage(channelId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    notifiedInternationalUpcoming.add(eventKey);
    trimSet(notifiedInternationalUpcoming);

    console.log(
      `[INTERNATIONAL UPCOMING] Sent: ${match.id}`
    );

    return true;

  } catch (error) {
    console.error(
      `[INTERNATIONAL UPCOMING] ${error.message}`
    );

    return false;
  }
}

// --------------------------------------------------
// INTERNATIONAL STARTING LINEUPS
// --------------------------------------------------

function getRosterGroups(data) {
  const groups = [];

  if (Array.isArray(data.rosters)) {
    groups.push(...data.rosters);
  }

  if (Array.isArray(data.lineups)) {
    groups.push(...data.lineups);
  }

  if (Array.isArray(data.boxscore?.players)) {
    groups.push(...data.boxscore.players);
  }

  return groups;
}

function getPlayersFromGroup(group) {
  const players = [];

  const directArrays = [
    group.roster,
    group.players,
    group.athletes,
    group.lineup
  ];

  for (const list of directArrays) {
    if (Array.isArray(list)) {
      players.push(...list);
    }
  }

  if (Array.isArray(group.statistics)) {
    for (const statistic of group.statistics) {
      if (Array.isArray(statistic.athletes)) {
        players.push(...statistic.athletes);
      }
    }
  }

  return players;
}

function extractTeamLineup(
  groups,
  teamId,
  teamName
) {
  for (const group of groups) {
    const groupTeam = group.team || {};

    const groupId = String(
      group.teamId ||
      groupTeam.id ||
      group.id ||
      ''
    );

    const groupName = String(
      groupTeam.displayName ||
      groupTeam.name ||
      group.name ||
      ''
    );

    const matchesTeam =
      (teamId && groupId === teamId) ||
      (
        !groupId &&
        groupName.toLowerCase() === teamName.toLowerCase()
      );

    if (!matchesTeam) continue;

    const players = getPlayersFromGroup(group);

    const starters = players
      .filter(player => {
        const starter =
          player.starter ??
          player.isStarter ??
          player.athlete?.starter;

        return (
          starter === true ||
          starter === 'true'
        );
      })
      .map(player => {
        const athlete =
          player.athlete ||
          player.player ||
          player;

        return {
          name:
            athlete.displayName ||
            athlete.fullName ||
            athlete.name ||
            '',

          number:
            player.jersey ||
            athlete.jersey ||
            player.jerseyNumber ||
            '',

          position:
            player.position?.abbreviation ||
            player.position?.name ||
            athlete.position?.abbreviation ||
            ''
        };
      })
      .filter(player => player.name);

    if (starters.length >= 11) {
      return starters.slice(0, 11);
    }
  }

  return [];
}

function formatLineup(teamName, players) {
  const lines = [
    `🔹 <b>${escapeHtml(teamName)}</b>`
  ];

  players.forEach((player, index) => {
    const number = player.number
      ? `${escapeHtml(player.number)}. `
      : `${index + 1}. `;

    const position = player.position
      ? ` <i>(${escapeHtml(player.position)})</i>`
      : '';

    lines.push(
      `${number}${escapeHtml(player.name)}${position}`
    );
  });

  return lines.join('\n');
}

async function checkInternationalLineups(
  bot,
  channelId,
  match
) {
  const eventKey =
    `international-lineup:${match.id}`;

  if (notifiedInternationalLineups.has(eventKey)) {
    return;
  }

  const now = Date.now();

  const lastCheck =
    lastInternationalLineupCheck.get(match.id);

  if (
    lastCheck &&
    now - lastCheck < LINEUP_RETRY_INTERVAL
  ) {
    return;
  }

  if (
    match.status !== 'SCHEDULED' &&
    !isLive(match.status)
  ) {
    return;
  }

  if (match.kickoff) {
    const kickoffTime =
      new Date(match.kickoff).getTime();

    if (
      Number.isFinite(kickoffTime) &&
      kickoffTime > now + 24 * 60 * 60 * 1000
    ) {
      return;
    }
  }

  lastInternationalLineupCheck.set(
    match.id,
    now
  );

  try {
    const url = new URL(
      `${ESPN_BASE}/${encodeURIComponent(match.league)}/summary`
    );

    url.searchParams.set('event', match.id);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const groups = getRosterGroups(data);

    const homeLineup = extractTeamLineup(
      groups,
      match.homeTeamId,
      match.homeTeam
    );

    const awayLineup = extractTeamLineup(
      groups,
      match.awayTeamId,
      match.awayTeam
    );

    if (
      homeLineup.length < 11 ||
      awayLineup.length < 11
    ) {
      console.log(
        `[INTERNATIONAL LINEUP] Waiting for both starting XIs: ${match.id}`
      );
      return;
    }

    const message = [
      '🌍 <b>INTERNATIONAL STARTING LINEUPS</b>',
      `🏆 <b>${escapeHtml(match.competition)}</b>`,
      LINE,
      formatLineup(match.homeTeam, homeLineup),
      '',
      LINE,
      formatLineup(match.awayTeam, awayLineup),
      '',
      LINE,
      BRAND
    ].join('\n');

    await bot.sendMessage(channelId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    notifiedInternationalLineups.add(eventKey);
    trimSet(notifiedInternationalLineups);

    console.log(
      `[INTERNATIONAL LINEUP] Sent: ${match.id}`
    );

  } catch (error) {
    console.error(
      `[INTERNATIONAL LINEUP] ${match.id}: ${error.message}`
    );
  }
}

// --------------------------------------------------
// AUTOMATIC INTERNATIONAL MONITOR
// --------------------------------------------------

export async function checkInternationalScores(
  bot,
  channelId
) {
  const { matches } =
    await fetchInternationalMatches();

  for (const match of matches) {
    await checkInternationalLineups(
      bot,
      channelId,
      match
    );

    await sendInternationalUpcomingAlert(
      bot,
      channelId,
      match
    );

    const oldMatch =
      previousInternationalMatches.get(match.id);

    if (!oldMatch) {
      previousInternationalMatches.set(
        match.id,
        match
      );

      continue;
    }

    let alertFailed = false;

    const scoreChanged =
      match.homeScore > oldMatch.homeScore ||
      match.awayScore > oldMatch.awayScore;

    if (
      scoreChanged &&
      isLive(match.status) &&
      config.goalAlerts?.enabled
    ) {
      const sent = await sendInternationalGoal(
        bot,
        channelId,
        match,
        oldMatch
      );

      if (!sent) {
        alertFailed = true;
      }
    }

    const statusSent =
      await sendInternationalStatusAlert(
        bot,
        channelId,
        match,
        oldMatch
      );

    if (!statusSent) {
      alertFailed = true;
    }

    if (alertFailed) {
      continue;
    }

    previousInternationalMatches.set(
      match.id,
      match
    );
  }

  console.log(
    `[INTERNATIONAL] Monitoring ${matches.length} matches.`
  );
}

// --------------------------------------------------
// EXPORT INTERNATIONAL LIVE MATCHES FOR /LIVE
// --------------------------------------------------

export async function fetchInternationalLiveMatches() {
  const { matches } =
    await fetchInternationalMatches();

  return matches.filter(
    match => isLive(match.status)
  );
}

// --------------------------------------------------
// /INTERNATIONAL COMMAND — ORIGINAL USER LAYOUT
// --------------------------------------------------

function formatInternationalMatch(match) {
  const lines = [
    `🏆 <b>${escapeHtml(match.competition)}</b>`,
    `🔵 <b>${escapeHtml(match.homeTeam)}</b>`
  ];

  if (
    isLive(match.status) ||
    match.status === 'FINISHED'
  ) {
    lines.push(
      `       <b>${match.homeScore} - ${match.awayScore}</b>`
    );
  } else {
    lines.push('⚔️ ⚔️ VS');
  }

  lines.push(
    `🔴 <b>${escapeHtml(match.awayTeam)}</b>`
  );

  if (isLive(match.status)) {
    const status = {
      HT: '⏸️ HALF-TIME',
      ET: '⏱️ EXTRA TIME',
      PEN: '🥅 PENALTY SHOOTOUT'
    };

    lines.push(
      status[match.status] ||
      `⏱️ ${escapeHtml(match.minute || '')}`
    );

  } else if (match.status === 'FINISHED') {
    lines.push('🏁 FULL-TIME');

  } else {
    lines.push(
      `🕒 KICK-OFF: ${escapeHtml(formatKickoff(match.kickoff))}`
    );
  }

  return lines.join('\n');
}

async function sendInternationalBoard(
  bot,
  chatId
) {
  const { matches } =
    await fetchInternationalMatches();

  const date = formatDate(new Date());

  if (!matches.length) {
    const emptyMessage = [
      BRAND,
      LINE,
      '🌐 <b>INTERNATIONAL MATCHES</b>',
      `📅 ${date}`,
      LINE,
      '⚠️ No international fixtures found today.',
      LINE,
      '📊 Matches found: 0',
      '🕒 Timezone: CAT (Zimbabwe)',
      BRAND
    ].join('\n');

    await bot.sendMessage(chatId, emptyMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    return;
  }

  matches.sort((a, b) => {
    return new Date(a.kickoff || 0) -
      new Date(b.kickoff || 0);
  });

  const uniqueMatches = [
    ...new Map(
      matches.map(match => [match.id, match])
    ).values()
  ];

  const header = [
    BRAND,
    LINE,
    '🌐 <b>INTERNATIONAL MATCHES</b>',
    `📅 ${date}`,
    LINE
  ].join('\n');

  const blocks = uniqueMatches.map(match => [
    formatInternationalMatch(match),
    LINE
  ].join('\n'));

  const footer = [
    `📊 Matches found: ${uniqueMatches.length}`,
    '🕒 Timezone: CAT (Zimbabwe)',
    BRAND
  ].join('\n');

  let message = header;

  for (const block of blocks) {
    const addition = `\n\n${block}`;

    if (
      message.length +
      addition.length +
      footer.length + 2 > 3800
    ) {
      await bot.sendMessage(
        chatId,
        `${message}\n\n${footer}`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );

      message = header;
    }

    message += addition;
  }

  await bot.sendMessage(
    chatId,
    `${message}\n\n${footer}`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }
  );
}

// --------------------------------------------------
// REGISTER COMMAND
// --------------------------------------------------

export function registerInternationalCommands(bot) {
  bot.onText(
    /^\/international(?:@\w+)?(?:\s|$)/i,
    async msg => {
      try {
        await sendInternationalBoard(
          bot,
          msg.chat.id
        );

      } catch (error) {
        console.error(
          `[INTERNATIONAL COMMAND] ${error.message}`
        );

        await bot.sendMessage(
          msg.chat.id,
          '⚠️ Could not load international matches. Please try again later.'
        ).catch(() => {});
      }
    }
  );

  console.log(
    '[INTERNATIONAL] /international command registered.'
  );
}
