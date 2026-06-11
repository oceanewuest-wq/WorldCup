const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_KEY = '04bbd8015b4c49c1b902713f538a409e';
const ADMIN_PASSWORD = 'ORSEN';
const MONGODB_URI = process.env.MONGODB_URI || null;

let db = null, stateCollection = null;

async function connectMongo() {
  if (!MONGODB_URI) { console.log('No MongoDB URI, using file storage'); return false; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI, {
      tls: true, tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
    });
    await client.connect();
    db = client.db('wc2026_v2');
    stateCollection = db.collection('state');
    console.log('✅ Connected to MongoDB!');
    return true;
  } catch(e) { console.log('MongoDB failed, using file storage:', e.message); return false; }
}

let sharedState = {
  players: {}, // { username: { pin, emoji, joinedAt } }
  bets: {}, // { matchId: { username: [s1, s2, penWinner] } }
  topScorerBets: {}, // { username: playerName }
  topScorerWinner: null,
  finalistBets: {}, // { username: [team1, team2] }
  finalists: null,
  wcWinnerBets: {}, // { username: teamName }
  wcWinner: null,
  goalScorerBets: {}, // { username: [{name, position}] }
  goalScorerStats: {}, // { playerName: { goals, cleanSheets } }
  scores: {}, // { matchId: { regular: [s1,s2], extra: [s1,s2], penalties: [s1,s2], winner: 'home'|'away'|null, status } }
  matches: [],
  scorerCandidates: [],
  lastMatchSync: 0,
  lastScoreSync: 0,
  lastSquadSync: 0,
  lastStatsSync: 0,
  wcCompetitionId: null
};

async function persistState() {
  if (stateCollection) {
    try { await stateCollection.replaceOne({_id:'main'}, {...sharedState,_id:'main'}, {upsert:true}); }
    catch(e) { console.log('MongoDB save error:', e.message); }
  } else {
    try { fs.writeFileSync('state.json', JSON.stringify(sharedState)); } catch(e) {}
  }
}

async function loadPersistedState() {
  if (stateCollection) {
    try {
      const doc = await stateCollection.findOne({_id:'main'});
      if (doc) { const {_id,...data} = doc; sharedState = {...sharedState,...data}; console.log('State loaded from MongoDB'); }
    } catch(e) { console.log('Load error:', e.message); }
  } else {
    try { const s = fs.readFileSync('state.json','utf8'); sharedState = {...sharedState,...JSON.parse(s)}; } catch(e) {}
  }
}

function apiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = { hostname:'api.football-data.org', path:apiPath, headers:{'X-Auth-Token':API_KEY}, method:'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.end();
  });
}

// All 84 known WC 2026 group stage matches hardcoded
const HARDCODED_MATCHES = [
  {id:'h1',team1:'Mexico',team2:'South Africa',date:'2026-06-11T19:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h2',team1:'South Korea',team2:'Czechia',date:'2026-06-12T02:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h3',team1:'Spain',team2:'Curaçao',date:'2026-06-12T00:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h4',team1:'Japan',team2:'Germany',date:'2026-06-12T18:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h5',team1:'USA',team2:'Panama',date:'2026-06-12T21:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h6',team1:'Uruguay',team2:'Senegal',date:'2026-06-13T00:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h7',team1:'France',team2:'Algeria',date:'2026-06-13T21:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h8',team1:'Argentina',team2:'Iraq',date:'2026-06-14T00:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h9',team1:'Austria',team2:'Scotland',date:'2026-06-14T18:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h10',team1:'Brazil',team2:'Norway',date:'2026-06-14T21:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h11',team1:'Portugal',team2:'Kuwait',date:'2026-06-15T00:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h12',team1:'Colombia',team2:'Romania',date:'2026-06-15T18:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h13',team1:'England',team2:'Serbia',date:'2026-06-15T21:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h14',team1:'Netherlands',team2:'New Zealand',date:'2026-06-16T00:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h15',team1:'Morocco',team2:'Ukraine',date:'2026-06-16T18:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h16',team1:'Belgium',team2:'Bolivia',date:'2026-06-16T21:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h17',team1:'Italy',team2:'Ecuador',date:'2026-06-17T00:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h18',team1:'Canada',team2:'Saudi Arabia',date:'2026-06-17T18:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h19',team1:'Switzerland',team2:'Cameroon',date:'2026-06-17T21:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h20',team1:'Turkey',team2:'Cape Verde',date:'2026-06-18T00:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h21',team1:'Ghana',team2:'Jordan',date:'2026-06-18T18:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h22',team1:'Croatia',team2:'DR Congo',date:'2026-06-18T21:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h23',team1:'Iran',team2:'Paraguay',date:'2026-06-19T00:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h24',team1:'Australia',team2:'Ivory Coast',date:'2026-06-19T18:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h25',team1:'Denmark',team2:'Nigeria',date:'2026-06-19T21:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h26',team1:'Poland',team2:'Qatar',date:'2026-06-20T00:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h27',team1:'Bosnia and Herzegovina',team2:'Uzbekistan',date:'2026-06-20T18:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
  {id:'h28',team1:'Chile',team2:'Iraq',date:'2026-06-20T21:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
  {id:'h29',team1:'Mexico',team2:'Czechia',date:'2026-06-21T21:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h30',team1:'South Africa',team2:'South Korea',date:'2026-06-22T00:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h31',team1:'Spain',team2:'Japan',date:'2026-06-16T18:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h32',team1:'Germany',team2:'Curaçao',date:'2026-06-17T00:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h33',team1:'USA',team2:'Senegal',date:'2026-06-17T21:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h34',team1:'Panama',team2:'Uruguay',date:'2026-06-18T00:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h35',team1:'France',team2:'Iraq',date:'2026-06-18T18:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h36',team1:'Algeria',team2:'Argentina',date:'2026-06-18T21:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h37',team1:'Brazil',team2:'Scotland',date:'2026-06-18T21:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h38',team1:'Norway',team2:'Austria',date:'2026-06-19T00:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h39',team1:'Portugal',team2:'Romania',date:'2026-06-19T18:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h40',team1:'Kuwait',team2:'Colombia',date:'2026-06-19T21:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h41',team1:'England',team2:'New Zealand',date:'2026-06-20T00:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h42',team1:'Serbia',team2:'Netherlands',date:'2026-06-20T18:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h43',team1:'Morocco',team2:'Bolivia',date:'2026-06-20T21:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h44',team1:'Ukraine',team2:'Belgium',date:'2026-06-21T00:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h45',team1:'Italy',team2:'Saudi Arabia',date:'2026-06-21T18:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h46',team1:'Ecuador',team2:'Canada',date:'2026-06-21T21:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h47',team1:'Switzerland',team2:'Cape Verde',date:'2026-06-22T00:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h48',team1:'Cameroon',team2:'Turkey',date:'2026-06-22T18:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h49',team1:'Ghana',team2:'DR Congo',date:'2026-06-22T18:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h50',team1:'Jordan',team2:'Croatia',date:'2026-06-22T21:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h51',team1:'Iran',team2:'Ivory Coast',date:'2026-06-23T00:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h52',team1:'Paraguay',team2:'Australia',date:'2026-06-23T18:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h53',team1:'Denmark',team2:'Qatar',date:'2026-06-23T21:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h54',team1:'Nigeria',team2:'Poland',date:'2026-06-24T00:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h55',team1:'Bosnia and Herzegovina',team2:'Iraq',date:'2026-06-24T18:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
  {id:'h56',team1:'Uzbekistan',team2:'Chile',date:'2026-06-24T21:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
  {id:'h57',team1:'Czechia',team2:'Mexico',date:'2026-06-25T21:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h58',team1:'South Korea',team2:'South Africa',date:'2026-06-25T21:00:00Z',stage:'GROUP_STAGE',group:'Group A',status:'SCHEDULED'},
  {id:'h59',team1:'Germany',team2:'Spain',date:'2026-06-25T21:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h60',team1:'Curaçao',team2:'Japan',date:'2026-06-25T21:00:00Z',stage:'GROUP_STAGE',group:'Group B',status:'SCHEDULED'},
  {id:'h61',team1:'Panama',team2:'Senegal',date:'2026-06-26T00:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h62',team1:'Uruguay',team2:'USA',date:'2026-06-26T00:00:00Z',stage:'GROUP_STAGE',group:'Group C',status:'SCHEDULED'},
  {id:'h63',team1:'Iraq',team2:'Algeria',date:'2026-06-26T21:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h64',team1:'Argentina',team2:'France',date:'2026-06-26T21:00:00Z',stage:'GROUP_STAGE',group:'Group D',status:'SCHEDULED'},
  {id:'h65',team1:'Norway',team2:'Scotland',date:'2026-06-27T00:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h66',team1:'Austria',team2:'Brazil',date:'2026-06-27T00:00:00Z',stage:'GROUP_STAGE',group:'Group E',status:'SCHEDULED'},
  {id:'h67',team1:'Romania',team2:'Kuwait',date:'2026-06-27T21:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h68',team1:'Colombia',team2:'Portugal',date:'2026-06-27T21:00:00Z',stage:'GROUP_STAGE',group:'Group F',status:'SCHEDULED'},
  {id:'h69',team1:'New Zealand',team2:'Serbia',date:'2026-06-28T00:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h70',team1:'Netherlands',team2:'England',date:'2026-06-28T00:00:00Z',stage:'GROUP_STAGE',group:'Group G',status:'SCHEDULED'},
  {id:'h71',team1:'Bolivia',team2:'Ukraine',date:'2026-06-28T21:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h72',team1:'Belgium',team2:'Morocco',date:'2026-06-28T21:00:00Z',stage:'GROUP_STAGE',group:'Group H',status:'SCHEDULED'},
  {id:'h73',team1:'Saudi Arabia',team2:'Ecuador',date:'2026-06-29T00:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h74',team1:'Canada',team2:'Italy',date:'2026-06-29T00:00:00Z',stage:'GROUP_STAGE',group:'Group I',status:'SCHEDULED'},
  {id:'h75',team1:'Cape Verde',team2:'Cameroon',date:'2026-06-29T21:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h76',team1:'Turkey',team2:'Switzerland',date:'2026-06-29T21:00:00Z',stage:'GROUP_STAGE',group:'Group J',status:'SCHEDULED'},
  {id:'h77',team1:'DR Congo',team2:'Jordan',date:'2026-06-30T00:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h78',team1:'Croatia',team2:'Ghana',date:'2026-06-30T00:00:00Z',stage:'GROUP_STAGE',group:'Group K',status:'SCHEDULED'},
  {id:'h79',team1:'Ivory Coast',team2:'Paraguay',date:'2026-06-30T21:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h80',team1:'Australia',team2:'Iran',date:'2026-06-30T21:00:00Z',stage:'GROUP_STAGE',group:'Group L',status:'SCHEDULED'},
  {id:'h81',team1:'Qatar',team2:'Nigeria',date:'2026-07-01T00:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h82',team1:'Poland',team2:'Denmark',date:'2026-07-01T00:00:00Z',stage:'GROUP_STAGE',group:'Group M',status:'SCHEDULED'},
  {id:'h83',team1:'Iraq',team2:'Uzbekistan',date:'2026-07-01T21:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
  {id:'h84',team1:'Chile',team2:'Bosnia and Herzegovina',date:'2026-07-01T21:00:00Z',stage:'GROUP_STAGE',group:'Group N',status:'SCHEDULED'},
];

async function syncMatches() {
  const now = Date.now();
  if (now - sharedState.lastMatchSync < 6 * 3600 * 1000) return;
  const idsToTry = [2000, 2001, 2018, 2019, 2021];
  for (const id of idsToTry) {
    try {
      const data = await apiGet(`/v4/competitions/${id}/matches`);
      if (data && data.matches && data.matches.length > 0) {
        const name = data.competition?.name || '';
        if (name.toLowerCase().includes('world cup') || name.toLowerCase().includes('world')) {
          sharedState.matches = data.matches.map(m => ({
            id: String(m.id), team1: m.homeTeam.name || m.homeTeam.shortName || 'TBD',
            team2: m.awayTeam.name || m.awayTeam.shortName || 'TBD',
            date: m.utcDate, stage: m.stage, group: m.group || m.stage, status: m.status
          }));
          sharedState.lastMatchSync = now;
          sharedState.wcCompetitionId = id;
          console.log(`Synced ${sharedState.matches.length} matches from competition ${id}: ${name}`);
          return;
        }
      }
    } catch(e) {}
  }
  // Fallback to hardcoded
  if (!sharedState.matches || sharedState.matches.length === 0) {
    sharedState.matches = HARDCODED_MATCHES;
    sharedState.lastMatchSync = now;
    console.log('Using hardcoded matches');
  }
}

async function syncScores() {
  const now = Date.now();
  if (now - sharedState.lastScoreSync < 3 * 60 * 1000) return;
  const compId = sharedState.wcCompetitionId || 2000;
  try {
    const data = await apiGet(`/v4/competitions/${compId}/matches?status=FINISHED`);
    if (data && data.matches) {
      data.matches.forEach(m => {
        const id = String(m.id);
        const reg = m.score?.regularTime;
        const ext = m.score?.extraTime;
        const pen = m.score?.penalties;
        const winner = m.score?.winner; // HOME_TEAM, AWAY_TEAM, DRAW
        if (reg && reg.home !== null) {
          sharedState.scores[id] = {
            regular: [reg.home, reg.away],
            extra: ext && ext.home !== null ? [ext.home, ext.away] : null,
            penalties: pen && pen.home !== null ? [pen.home, pen.away] : null,
            winner: winner === 'HOME_TEAM' ? 'home' : winner === 'AWAY_TEAM' ? 'away' : 'draw',
            status: 'FINISHED'
          };
        }
      });
      // Also check live
      const live = await apiGet(`/v4/competitions/${compId}/matches?status=IN_PLAY`);
      if (live && live.matches) {
        live.matches.forEach(m => {
          const id = String(m.id);
          const reg = m.score?.regularTime || m.score?.fullTime;
          if (reg && reg.home !== null) {
            sharedState.scores[id] = {
              regular: [reg.home, reg.away], extra: null, penalties: null, winner: null, status: 'IN_PLAY'
            };
          }
        });
      }
      sharedState.lastScoreSync = now;
    }
  } catch(e) { console.log('Score sync error:', e.message); }
}

async function syncGoalscorerStats() {
  const now = Date.now();
  if (now - sharedState.lastStatsSync < 6 * 3600 * 1000) return;
  const compId = sharedState.wcCompetitionId || 2000;
  try {
    const data = await apiGet(`/v4/competitions/${compId}/scorers?limit=50`);
    if (data && data.scorers) {
      data.scorers.forEach(s => {
        const name = s.player.name;
        if (!sharedState.goalScorerStats[name]) sharedState.goalScorerStats[name] = { goals: 0, cleanSheets: 0 };
        sharedState.goalScorerStats[name].goals = s.numberOfGoals || 0;
      });
      sharedState.lastStatsSync = now;
      console.log('Goalscorer stats synced');
    }
  } catch(e) {}
}

async function syncSquads() {
  const now = Date.now();
  if (now - sharedState.lastSquadSync < 24 * 3600 * 1000) return;
  const compId = sharedState.wcCompetitionId || 2000;
  try {
    const data = await apiGet(`/v4/competitions/${compId}/teams`);
    if (data && data.teams && data.teams.length > 0) {
      const players = [];
      for (const team of data.teams.slice(0, 48)) {
        try {
          const squad = await apiGet(`/v4/teams/${team.id}`);
          if (squad && squad.squad) {
            squad.squad.forEach(p => {
              const pos = p.position;
              if (['Attacker','Midfielder','Defender','Goalkeeper'].includes(pos)) {
                players.push({ name: `${p.name} (${team.shortName||team.name})`, position: pos });
              }
            });
          }
          await new Promise(r => setTimeout(r, 350));
        } catch(e) {}
      }
      if (players.length > 10) {
        sharedState.scorerCandidates = players.sort((a,b)=>a.name.localeCompare(b.name));
        sharedState.lastSquadSync = now;
        console.log(`Synced ${players.length} players`);
      }
    }
  } catch(e) {}
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin + 'wc2026salt').digest('hex');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const sendJSON = (data, code=200) => {
    res.writeHead(code, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data));
  };

  const getBody = () => new Promise(resolve => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });

  // Register
  if (req.url === '/api/register' && req.method === 'POST') {
    const { username, pin, emoji } = await getBody();
    if (!username || !pin || !emoji) return sendJSON({error:'Missing fields'}, 400);
    if (sharedState.players[username]) return sendJSON({error:'Username already taken'}, 409);
    sharedState.players[username] = { pin: hashPin(pin), emoji, joinedAt: Date.now() };
    await persistState();
    return sendJSON({ok:true, username, emoji});
  }

  // Login
  if (req.url === '/api/login' && req.method === 'POST') {
    const { username, pin } = await getBody();
    const player = sharedState.players[username];
    if (!player) return sendJSON({error:'User not found'}, 404);
    if (player.pin !== hashPin(pin)) return sendJSON({error:'Wrong PIN'}, 401);
    return sendJSON({ok:true, username, emoji: player.emoji});
  }

  // Get state (public)
  if (req.url === '/api/state' && req.method === 'GET') {
    return sendJSON(sharedState);
  }

  // Save user actions (bets, picks)
  if (req.url === '/api/save' && req.method === 'POST') {
    const update = await getBody();
    if (update.bets) {
      for (const [matchId, matchBets] of Object.entries(update.bets)) {
        if (!sharedState.bets[matchId]) sharedState.bets[matchId] = {};
        Object.assign(sharedState.bets[matchId], matchBets);
      }
    }
    if (update.topScorerBets) sharedState.topScorerBets = {...sharedState.topScorerBets, ...update.topScorerBets};
    if (update.finalistBets) sharedState.finalistBets = {...sharedState.finalistBets, ...update.finalistBets};
    if (update.wcWinnerBets) sharedState.wcWinnerBets = {...sharedState.wcWinnerBets, ...update.wcWinnerBets};
    if (update.goalScorerBets) sharedState.goalScorerBets = {...sharedState.goalScorerBets, ...update.goalScorerBets};
    await persistState();
    return sendJSON({ok:true});
  }

  // Admin actions
  if (req.url === '/api/admin' && req.method === 'POST') {
    const { password, action, data } = await getBody();
    if (password !== ADMIN_PASSWORD) return sendJSON({error:'Wrong password'}, 401);
    if (action === 'setWcWinner') sharedState.wcWinner = data.winner;
    if (action === 'setFinalists') sharedState.finalists = data.finalists;
    if (action === 'setTopScorer') sharedState.topScorerWinner = data.topScorer;
    if (action === 'setGoalscorerStats') {
      sharedState.goalScorerStats = {...sharedState.goalScorerStats, ...data.stats};
    }
    if (action === 'setPenWinner') {
      const { matchId, winner } = data;
      if (sharedState.scores[matchId]) sharedState.scores[matchId].penWinner = winner;
    }
    if (action === 'resetPlayer') {
      const { username } = data;
      if (sharedState.players[username]) sharedState.players[username].pin = hashPin(data.newPin);
    }
    await persistState();
    return sendJSON({ok:true});
  }

  // Serve HTML
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const file = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(file);
    } catch(e) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

async function main() {
  await connectMongo();
  await loadPersistedState();
  await syncMatches();
  await syncScores();
  await syncSquads();
  setInterval(async () => {
    await syncScores();
    await syncGoalscorerStats();
    await persistState();
  }, 3 * 60 * 1000);
  setInterval(async () => {
    await syncMatches();
    await syncSquads();
  }, 6 * 3600 * 1000);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`⚽ WC2026 Predictions v2 running on port ${PORT}`));
}

main();
