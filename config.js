const config = {
  // Website
  website: 'https://football-live-hd-proo.vercel.app',

  // Match checking
  pollInterval: 60_000,

  // Goal alert settings
  goalAlerts: {
    enabled: true,
    showCompetition: true,
    showTeams: true,
    showScore: true,
    showScorer: true,
    showMinute: true,
    showWebsite: true,

    emoji: '⚽',
    title: 'GOAL!',
    scoreSeparator: ' - '
  },

  // Match event alerts
  matchAlerts: {
    enabled: true,
    kickoff: true,
    halfTime: true,
    secondHalfKickoff: true,
    fullTime: true,
    extraTime: true,
    penalties: true
  },

  // Live match display
  liveMatches: {
    enabled: true,
    maxResults: 25,
    showCompetition: true,
    showMinute: true
  },
  
  // Upcoming match reminders
upcomingMatches: {
  enabled: true,
  reminderMinutes: 30
},

  // Telegram formatting
  telegram: {
    parseMode: 'HTML',
    disableWebPagePreview: true
  },

  // Logging
  logging: {
    enabled: true
  }
};

export default config;