
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const deck = JSON.parse(fs.readFileSync(path.join(__dirname, "deck.json"), "utf8"));
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function secureShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function safeName(name) {
  const n = String(name || "Adventurer").trim().slice(0, 24);
  return n || "Adventurer";
}
function cleanCard(text, max = 180) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}
function makePlayer(id, name, isBot = false) {
  return { id, name: safeName(name), isBot, connected: true, score: 0, hand: [], submitted: null, voted: false };
}
function getJudge(room) {
  if (!room.players.length) return null;
  room.judgeIndex %= room.players.length;
  return room.players[room.judgeIndex];
}
function selectedPools(room) {
  const prompts = [];
  const answers = [];
  for (const [key, enabled] of Object.entries(room.enabledPacks)) {
    if (!enabled) continue;
    const pack = deck.packs[key];
    if (!pack) continue;
    prompts.push(...pack.prompts);
    answers.push(...pack.answers);
  }
  prompts.push(...room.customPrompts);
  answers.push(...room.customAnswers);
  return { prompts, answers };
}
function resetPools(room) {
  const pools = selectedPools(room);
  room.promptPile = shuffle([...pools.prompts]);
  room.answerPile = shuffle([...pools.answers]);
}
function drawPrompt(room) {
  if (!room.promptPile.length) {
    const { prompts } = selectedPools(room);
    room.promptPile = shuffle([...prompts]);
  }
  return room.promptPile.pop();
}
function drawAnswer(room) {
  if (!room.answerPile.length) {
    const { answers } = selectedPools(room);
    room.answerPile = shuffle([...answers]);
  }
  return room.answerPile.pop();
}
function fillHand(room, player) {
  while (player.hand.length < room.handSize) player.hand.push(drawAnswer(room));
}
function ruleInfo(id) {
  return deck.specialRules.find(x => x.id === id) || deck.specialRules[0];
}
function chooseRule(room) {
  if (!room.specialRounds || room.round < 2) return "normal";
  const x = Math.random();
  if (x < 0.62) return "normal";
  if (x < 0.74) return "double";
  if (x < 0.84) return "wild";
  if (x < 0.94) return "speed";
  return "democracy";
}
function publicState(room, playerId) {
  const judge = getJudge(room);
  const me = room.players.find(p => p.id === playerId);
  const visibleSubs = ["judging", "voting", "roundEnd"].includes(room.state)
    ? room.submissions.map(s => ({
        token: s.token,
        text: s.text,
        playerId: room.state === "roundEnd" ? s.playerId : null,
        votes: room.state === "roundEnd" ? (s.votes || 0) : undefined,
        isMine: s.playerId === playerId,
      }))
    : [];
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    prompt: room.prompt,
    pointsToWin: room.pointsToWin,
    handSize: room.handSize,
    enabledPacks: room.enabledPacks,
    specialRounds: room.specialRounds,
    roundRule: room.roundRule,
    ruleInfo: ruleInfo(room.roundRule),
    deadline: room.deadline,
    judgeId: judge?.id || null,
    judgeName: judge?.name || null,
    winnerId: room.winnerId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected, submitted: !!p.submitted, voted: p.voted, isBot: !!p.isBot
    })),
    hand: me?.hand || [],
    isHost: room.hostId === playerId,
    isJudge: judge?.id === playerId,
    submitted: !!me?.submitted,
    voted: !!me?.voted,
    submissions: visibleSubs,
    customPrompts: room.customPrompts,
    customAnswers: room.customAnswers,
  };
}
function emitRoom(room) {
  for (const p of room.players) {
    if (!p.isBot) io.to(p.id).emit("state", publicState(room, p.id));
  }
}
function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.deadline = null;
}
function makeRoom(hostId, name) {
  let code;
  do code = makeCode(); while (rooms.has(code));
  const room = {
    code,
    hostId,
    state: "lobby",
    round: 0,
    judgeIndex: 0,
    prompt: null,
    winnerId: null,
    submissions: [],
    players: [makePlayer(hostId, name, false)],
    pointsToWin: 7,
    handSize: 8,
    enabledPacks: { general: true, exodium: true, raunchy: false },
    specialRounds: true,
    roundRule: "normal",
    deadline: null,
    timer: null,
    customPrompts: [],
    customAnswers: [],
    promptPile: [],
    answerPile: [],
  };
  rooms.set(code, room);
  return room;
}
const BOT_NAMES = ["MurlocMike","LeeroyBot","HoggerAI","BankAlt","CritChicken","LootGoblin","AFKAndy","ManaTea","PullTimer","FloorTank","RNGesus","MailboxMage"];
function addBot(room) {
  if (room.players.length >= 12) return false;
  const used = new Set(room.players.map(p => p.name));
  let name = BOT_NAMES.find(n => !used.has(n)) || `Bot${room.players.filter(p => p.isBot).length + 1}`;
  const id = `bot_${room.code}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  room.players.push(makePlayer(id, name, true));
  return true;
}
function removeBot(room) {
  for (let i = room.players.length - 1; i >= 0; i--) {
    if (room.players[i].isBot) {
      room.players.splice(i, 1);
      if (room.judgeIndex >= room.players.length) room.judgeIndex = 0;
      return true;
    }
  }
  return false;
}
function beginSpeedTimer(room) {
  clearTimer(room);
  room.deadline = Date.now() + 25000;
  room.timer = setTimeout(() => {
    if (room.state !== "playing" || room.roundRule !== "speed") return;
    const judge = getJudge(room);
    for (const player of room.players) {
      if (player.id === judge?.id || player.submitted) continue;
      if (!player.hand.length) continue;
      if (player.isBot) {
        botSubmit(room, player);
      } else {
        const idx = Math.floor(Math.random() * player.hand.length);
        const picked = player.hand.splice(idx, 1)[0];
        player.submitted = { cards: [picked], wild: null };
        fillHand(room, player);
      }
    }
    finalizeSubmissions(room);
  }, 25000);
}
function startRound(room) {
  clearTimer(room);
  room.state = "playing";
  room.round += 1;
  room.prompt = drawPrompt(room);
  room.winnerId = null;
  room.submissions = [];
  room.roundRule = chooseRule(room);
  for (const player of room.players) {
    player.submitted = null;
    player.voted = false;
    fillHand(room, player);
  }
  if (room.roundRule === "speed") beginSpeedTimer(room);
  emitRoom(room);
  scheduleBotSubmissions(room);
}
function submissionText(room, submitted) {
  if (!submitted) return "";
  if (room.roundRule === "wild" && submitted.wild) return cleanCard(submitted.wild, 160);
  if (room.roundRule === "double") return (submitted.cards || []).join("  +  ");
  return (submitted.cards || [])[0] || "";
}
function finalizeSubmissions(room) {
  clearTimer(room);
  const judge = getJudge(room);
  const entrants = room.players.filter(p => p.id !== judge?.id);
  if (!entrants.length) return;
  if (!entrants.every(p => p.submitted)) return;
  room.submissions = secureShuffle(entrants.map(p => ({
    playerId: p.id,
    text: submissionText(room, p.submitted),
    token: Math.random().toString(36).slice(2, 10),
    votes: 0
  })));
  room.state = room.roundRule === "democracy" ? "voting" : "judging";
  emitRoom(room);
  if (room.state === "judging") scheduleBotJudge(room);
  if (room.state === "voting") scheduleBotVotes(room);
}
function awardWinner(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  player.score += 1;
  room.winnerId = playerId;
  room.state = "roundEnd";
  clearTimer(room);
  emitRoom(room);
}
function maybeFinishVote(room) {
  const eligible = room.players;
  if (!eligible.every(p => p.voted)) return;
  const maxVotes = Math.max(...room.submissions.map(s => s.votes || 0));
  const top = room.submissions.filter(s => (s.votes || 0) === maxVotes);
  const pick = top[Math.floor(Math.random() * top.length)];
  awardWinner(room, pick.playerId);
}
function botSubmit(room, player) {
  if (player.submitted || room.state !== "playing") return;
  if (room.roundRule === "wild" && Math.random() < 0.28) {
    const wilds = [
      "a suspiciously overgeared murloc",
      "someone blaming lag with 12 ms ping",
      "the world's most confident grey parser",
      "an emergency guild meeting about absolutely nothing",
      "a hunter pet with better raid awareness than the group",
      "an addon that just says skill issue"
    ];
    player.submitted = { cards: [], wild: wilds[Math.floor(Math.random() * wilds.length)] };
    return;
  }
  const need = room.roundRule === "double" ? 2 : 1;
  const indexes = shuffle([...Array(player.hand.length).keys()]).slice(0, Math.min(need, player.hand.length)).sort((a, b) => b - a);
  const picks = indexes.map(i => player.hand.splice(i, 1)[0]).reverse();
  player.submitted = { cards: picks, wild: null };
  fillHand(room, player);
}
function scheduleBotSubmissions(room) {
  if (room.state !== "playing") return;
  const judge = getJudge(room);
  room.players.filter(p => p.isBot && p.id !== judge?.id).forEach((player, i) => {
    setTimeout(() => {
      if (!rooms.has(room.code) || room.state !== "playing" || player.submitted) return;
      botSubmit(room, player);
      emitRoom(room);
      finalizeSubmissions(room);
    }, 650 + i * 350 + Math.floor(Math.random() * 450));
  });
}
function scheduleBotJudge(room) {
  const judge = getJudge(room);
  if (!judge?.isBot) return;
  setTimeout(() => {
    if (!rooms.has(room.code) || room.state !== "judging" || !room.submissions.length) return;
    const pick = room.submissions[crypto.randomInt(room.submissions.length)];
    awardWinner(room, pick.playerId);
  }, 1000 + Math.floor(Math.random() * 800));
}
function scheduleBotVotes(room) {
  room.players.filter(p => p.isBot && !p.voted).forEach((player, i) => {
    setTimeout(() => {
      if (!rooms.has(room.code) || room.state !== "voting" || player.voted) return;
      const choices = room.submissions.filter(s => s.playerId !== player.id);
      if (!choices.length) {
        player.voted = true;
        emitRoom(room);
        maybeFinishVote(room);
        return;
      }
      const pick = choices[crypto.randomInt(choices.length)];
      pick.votes = (pick.votes || 0) + 1;
      player.voted = true;
      emitRoom(room);
      maybeFinishVote(room);
    }, 700 + i * 300 + Math.floor(Math.random() * 400));
  });
}
function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;
  room.players.splice(idx, 1);
  if (!room.players.length) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) room.hostId = room.players[0].id;
  if (room.judgeIndex >= room.players.length) room.judgeIndex = 0;
  emitRoom(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }, cb) => {
    const room = makeRoom(socket.id, name);
    socket.join(room.code);
    cb?.({ ok: true, code: room.code });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ name, code }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase().trim());
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.state !== "lobby") return cb?.({ ok: false, error: "Game already started." });
    if (room.players.length >= 12) return cb?.({ ok: false, error: "Room is full." });
    room.players.push(makePlayer(socket.id, name, false));
    socket.join(room.code);
    cb?.({ ok: true, code: room.code });
    emitRoom(room);
  });

  socket.on("settings", ({ code, pointsToWin, handSize, enabledPacks, specialRounds }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    room.pointsToWin = Math.max(3, Math.min(20, Number(pointsToWin) || 7));
    room.handSize = Math.max(5, Math.min(12, Number(handSize) || 8));
    room.enabledPacks = {
      general: enabledPacks?.general !== false,
      exodium: !!enabledPacks?.exodium,
      raunchy: !!enabledPacks?.raunchy
    };
    if (!Object.values(room.enabledPacks).some(Boolean)) room.enabledPacks.general = true;
    room.specialRounds = specialRounds !== false;
    emitRoom(room);
  });

  socket.on("customCards", ({ code, prompts, answers }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    room.customPrompts = (Array.isArray(prompts) ? prompts : []).map(x => cleanCard(x, 180)).filter(Boolean).slice(0, 100);
    room.customAnswers = (Array.isArray(answers) ? answers : []).map(x => cleanCard(x, 160)).filter(Boolean).slice(0, 250);
    emitRoom(room);
  });

  socket.on("addBot", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    if (addBot(room)) emitRoom(room);
  });

  socket.on("removeBot", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    if (removeBot(room)) emitRoom(room);
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return cb?.({ ok: false, error: "You need at least 3 players." });
    const pools = selectedPools(room);
    if (pools.prompts.length < 5 || pools.answers.length < room.handSize * room.players.length) {
      return cb?.({ ok: false, error: "Not enough cards in the selected decks." });
    }
    room.judgeIndex = 0;
    for (const p of room.players) {
      p.score = 0;
      p.hand = [];
      p.submitted = null;
      p.voted = false;
    }
    resetPools(room);
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("submitCards", ({ code, indices, wild }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;
    const judge = getJudge(room);
    if (judge?.id === socket.id) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.submitted) return;

    const wildText = cleanCard(wild, 160);
    if (room.roundRule === "wild" && wildText) {
      player.submitted = { cards: [], wild: wildText };
      emitRoom(room);
      finalizeSubmissions(room);
      return;
    }

    const need = room.roundRule === "double" ? 2 : 1;
    const picks = [...new Set((Array.isArray(indices) ? indices : []).map(Number))]
      .filter(i => Number.isInteger(i) && i >= 0 && i < player.hand.length)
      .slice(0, need);

    if (picks.length !== need) return;
    picks.sort((a, b) => b - a);
    const cards = picks.map(i => player.hand.splice(i, 1)[0]).reverse();
    player.submitted = { cards, wild: null };
    fillHand(room, player);
    emitRoom(room);
    finalizeSubmissions(room);
  });

  socket.on("pickWinner", ({ code, token }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "judging" || getJudge(room)?.id !== socket.id) return;
    const picked = room.submissions.find(s => s.token === token);
    if (picked) awardWinner(room, picked.playerId);
  });

  socket.on("vote", ({ code, token }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "voting") return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.voted) return;
    const picked = room.submissions.find(s => s.token === token);
    if (!picked || picked.playerId === socket.id) return;
    picked.votes = (picked.votes || 0) + 1;
    player.voted = true;
    emitRoom(room);
    maybeFinishVote(room);
  });

  socket.on("nextRound", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.state !== "roundEnd") return;
    if (Math.max(...room.players.map(p => p.score)) >= room.pointsToWin) {
      room.state = "gameOver";
      emitRoom(room);
      return;
    }
    room.judgeIndex = (room.judgeIndex + 1) % room.players.length;
    startRound(room);
  });

  socket.on("restart", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    clearTimer(room);
    room.state = "lobby";
    room.round = 0;
    room.prompt = null;
    room.winnerId = null;
    room.submissions = [];
    room.deadline = null;
    room.judgeIndex = 0;
    for (const p of room.players) {
      p.score = 0;
      p.hand = [];
      p.submitted = null;
      p.voted = false;
    }
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.some(p => p.id === socket.id)) {
        removePlayer(room, socket.id);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Azeroth After Dark v3.1 running on http://localhost:${PORT}`));
