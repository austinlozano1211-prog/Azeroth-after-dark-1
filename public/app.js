
const socket = io();
let roomCode = null;
let state = null;
let selectedIndices = [];
let timerHandle = null;

let audioCtx = null;
let musicMaster = null;
let musicNodes = [];
let musicTimer = null;
let musicOn = false;
let musicBar = 0;

function stopMusic(){
  if(musicTimer){ clearInterval(musicTimer); musicTimer = null; }
  for(const node of musicNodes){
    try{ node.stop?.(); }catch(_e){}
    try{ node.disconnect?.(); }catch(_e){}
  }
  musicNodes = [];
  if(musicMaster){ try{ musicMaster.disconnect(); }catch(_e){} musicMaster = null; }
  if(audioCtx){ try{ audioCtx.close(); }catch(_e){} audioCtx = null; }
  musicOn = false;
  const btn = document.getElementById("musicBtn");
  if(btn){ btn.textContent = "♫ Music Off"; btn.setAttribute("aria-pressed","false"); }
}

function playTone(ctx,destination,frequency,start,duration,gainValue,type="sine"){
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency,start);
  gain.gain.setValueAtTime(0.0001,start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002,gainValue),start+0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001,start+duration);
  osc.connect(gain); gain.connect(destination);
  osc.start(start); osc.stop(start+duration+0.05);
  musicNodes.push(osc,gain);
}

function scheduleFantasyBar(){
  if(!audioCtx || !musicMaster) return;
  const now = audioCtx.currentTime + 0.05;
  const chords = [
    [110.00,164.81,220.00],
    [98.00,146.83,196.00],
    [87.31,130.81,174.61],
    [98.00,146.83,196.00]
  ];
  const chord = chords[musicBar % chords.length];
  musicBar += 1;
  chord.forEach((f,i)=>playTone(audioCtx,musicMaster,f,now,6.4,i===0?0.035:0.022,i===0?"triangle":"sine"));
  const notes=[220.00,261.63,293.66,329.63,392.00,440.00];
  const melodyPatterns=[[0,2,4,2,1,3,4,2],[2,4,5,4,2,1,3,1],[0,3,4,3,1,2,4,2],[1,2,4,5,4,2,1,0]];
  const pattern=melodyPatterns[(musicBar-1)%melodyPatterns.length];
  for(let i=0;i<8;i++) playTone(audioCtx,musicMaster,notes[pattern[i]],now+i*0.72,0.5,0.018,"triangle");
  playTone(audioCtx,musicMaster,55,now,6.6,0.012,"sine");
}

async function startMusic(){
  if(musicOn) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx){ alert("This browser does not support the built-in ambience."); return; }
  audioCtx = new Ctx();
  musicMaster = audioCtx.createGain();
  musicMaster.gain.value = 0.32;
  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24; compressor.knee.value = 18; compressor.ratio.value = 5; compressor.attack.value = 0.03; compressor.release.value = 0.3;
  musicMaster.connect(compressor); compressor.connect(audioCtx.destination);
  musicOn = true; musicBar = 0;
  const btn = document.getElementById("musicBtn");
  btn.textContent = "♫ Music On"; btn.setAttribute("aria-pressed","true");
  scheduleFantasyBar();
  musicTimer = setInterval(scheduleFantasyBar,6000);
}
function toggleMusic(){ if(musicOn) stopMusic(); else startMusic(); }


const $ = id => document.getElementById(id);
const screens = ["home","lobby","game"];
const deg2rad = deg => deg * Math.PI / 180;

function show(name){ screens.forEach(s => $(s).classList.toggle("hidden", s !== name)); }
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function lines(v){ return String(v || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
function initials(name){ return String(name || "?").split(/\s+/).slice(0,2).map(x => x[0]?.toUpperCase() || "").join("").slice(0,2); }
function meId(){ return socket.id; }

$("musicBtn").addEventListener("click", toggleMusic);

$("createBtn").addEventListener("click", () => {
  socket.emit("createRoom", { name: $("nameInput").value.trim() }, res => {
    if(res?.ok){ roomCode = res.code; $("roomBadge").textContent = `ROOM ${roomCode}`; $("roomBadge").classList.remove("hidden"); }
  });
});
$("joinBtn").addEventListener("click", () => {
  $("homeError").textContent = "";
  socket.emit("joinRoom", { name: $("nameInput").value.trim(), code: $("roomInput").value.trim().toUpperCase() }, res => {
    if(!res?.ok) $("homeError").textContent = res?.error || "Could not join.";
    else { roomCode = res.code; $("roomBadge").textContent = `ROOM ${roomCode}`; $("roomBadge").classList.remove("hidden"); }
  });
});
$("addBotBtn").addEventListener("click", () => { if(state?.isHost) socket.emit("addBot", { code: roomCode }); });
$("removeBotBtn").addEventListener("click", () => { if(state?.isHost) socket.emit("removeBot", { code: roomCode }); });
$("saveSettingsBtn").addEventListener("click", () => {
  if(!state?.isHost) return;
  socket.emit("settings", {
    code: roomCode,
    pointsToWin: $("pointsInput").value,
    handSize: $("handSizeInput").value,
    enabledPacks: { general: $("packGeneral").checked, exodium: $("packExodium").checked, raunchy: $("packRaunchy").checked },
    specialRounds: $("specialRounds").checked
  });
});
$("saveCustomBtn").addEventListener("click", () => {
  if(!state?.isHost) return;
  socket.emit("customCards", { code: roomCode, prompts: lines($("customPrompts").value), answers: lines($("customAnswers").value) });
  $("customStatus").textContent = "Custom cards saved to this room.";
});
$("startBtn").addEventListener("click", () => { socket.emit("startGame", { code: roomCode }, res => { if(res && !res.ok) alert(res.error); }); });
$("nextRoundBtn").addEventListener("click", () => socket.emit("nextRound", { code: roomCode }));
$("restartBtn").addEventListener("click", () => socket.emit("restart", { code: roomCode }));
$("submitSelectedBtn").addEventListener("click", submitSelected);
$("wildSubmit").addEventListener("click", () => {
  const text = $("wildInput").value.trim();
  if(!text) return;
  socket.emit("submitCards", { code: roomCode, indices: [], wild: text });
  $("wildInput").value = "";
});

socket.on("state", s => {
  state = s;
  selectedIndices = [];
  roomCode = s.code;
  $("roomBadge").textContent = `ROOM ${s.code}`;
  $("roomBadge").classList.remove("hidden");
  if(s.state === "lobby") renderLobby(); else renderGame();
});

function renderLobby(){
  stopTimer();
  show("lobby");
  $("pointsInput").value = state.pointsToWin;
  $("handSizeInput").value = state.handSize;
  $("packGeneral").checked = !!state.enabledPacks.general;
  $("packExodium").checked = !!state.enabledPacks.exodium;
  $("packRaunchy").checked = !!state.enabledPacks.raunchy;
  $("specialRounds").checked = !!state.specialRounds;
  ["pointsInput","handSizeInput","packGeneral","packExodium","packRaunchy","specialRounds","saveSettingsBtn","customPrompts","customAnswers","saveCustomBtn"]
    .forEach(id => $(id).disabled = !state.isHost);
  $("startBtn").classList.toggle("hidden", !state.isHost);
  $("botControls").classList.toggle("hidden", !state.isHost);
  $("addBotBtn").disabled = !state.isHost || state.players.length >= 12;
  $("removeBotBtn").disabled = !state.isHost || !state.players.some(p => p.isBot);
  $("customPrompts").value = (state.customPrompts || []).join("\n");
  $("customAnswers").value = (state.customAnswers || []).join("\n");
  $("lobbyPlayers").innerHTML = state.players.map(p => `
    <div class="player-row">
      <span>${esc(p.name)} ${p.id === state.hostId ? "👑" : ""} ${p.isBot ? '<span class="bot-tag">BOT</span>' : ""}</span>
      <span>${p.isBot ? "AI Ready" : (p.connected ? "Ready" : "Disconnected")}</span>
    </div>`).join("");
}

function renderGame(){
  show("game");
  renderRule();
  renderSeats();
  renderPromptAndStatus();
  renderHand();
  renderSubmissions();
  renderRoundButtons();
  renderTimer();
}

function renderRule(){
  const ri = state.ruleInfo || { name:"Standard Round", desc:"One prompt, one answer." };
  $("roundRuleBanner").textContent = `${ri.name}: ${ri.desc}`;
}

function renderSeats(){
  $("playerSeats").innerHTML = "";
  const self = state.players.find(p => p.id === meId());
  const others = state.players.filter(p => p.id !== meId());
  let angles = [];
  if (others.length === 1) angles = [270];
  else if (others.length > 1) {
    const start = 210, end = 330;
    const step = (end - start) / (others.length - 1);
    angles = others.map((_, i) => start + i * step);
  }
  others.forEach((p, i) => {
    const angle = deg2rad(angles[i]);
    createSeat(p, 50 + Math.cos(angle) * 41, 50 + Math.sin(angle) * 33, false);
  });
  if (self) createSeat(self, 50, 89, true);
}

function createSeat(player, left, top, isSelf){
  const seat = document.createElement("div");
  const winner = state.winnerId === player.id && state.state === "roundEnd";
  seat.className = `seat${isSelf ? " you" : ""}${player.id === state.judgeId ? " judge" : ""}${player.submitted ? " submitted" : ""}${winner ? " winner" : ""}`;
  seat.style.left = `${left}%`;
  seat.style.top = `${top}%`;

  const meta = [];
  if (isSelf) meta.push('<span class="badge">YOU</span>');
  if (player.isBot) meta.push('<span class="badge">BOT</span>');
  if (player.id === state.judgeId) meta.push('<span class="badge judge">JUDGE</span>');
  if (player.submitted) meta.push('<span class="badge played">PLAYED</span>');
  if (player.voted) meta.push('<span class="badge vote">VOTED</span>');
  if (winner) meta.push('<span class="badge win">WINNER</span>');

  seat.innerHTML = `
    <div class="seat-panel">
      <div class="avatar">${esc(initials(player.name))}</div>
      <div class="seat-name">${esc(player.name)}</div>
      <div class="seat-score">${player.score} point${player.score === 1 ? "" : "s"}</div>
      <div class="seat-meta">${meta.join("")}</div>
    </div>`;
  $("playerSeats").appendChild(seat);
}

function renderPromptAndStatus(){
  $("judgeBanner").textContent = state.judgeName ? `${state.judgeName} is judging this round` : "";
  $("promptCard").textContent = state.prompt || "Waiting for the next prompt...";
  if(state.state === "playing"){
    if(state.isJudge) $("statusText").textContent = "You are the judge. Sit back and wait for the rest of the table to submit.";
    else if(state.submitted) $("statusText").textContent = "Answer submitted. Now watch the rest of these degenerates cook.";
    else if(state.roundRule === "double") $("statusText").textContent = "Choose TWO cards. The filthier the combo, the better.";
    else if(state.roundRule === "wild") $("statusText").textContent = "Play a card or type your own answer.";
    else if(state.roundRule === "speed") $("statusText").textContent = "Bloodlust round. Pick fast and pick dirty.";
    else $("statusText").textContent = "Choose one answer card from your hand.";
  } else if(state.state === "judging"){
    $("statusText").textContent = state.isJudge ? "Choose the winner." : "The judge is deciding which answer was the most unhinged.";
  } else if(state.state === "voting"){
    $("statusText").textContent = state.voted ? "Vote locked in." : "Council vote: pick your favorite answer. You cannot vote for your own.";
  } else if(state.state === "roundEnd"){
    const winner = state.players.find(p => p.id === state.winnerId);
    $("statusText").textContent = winner ? `${winner.name} wins the round.` : "Round complete.";
  } else if(state.state === "gameOver"){
    const top = [...state.players].sort((a,b) => b.score - a.score)[0];
    $("statusText").textContent = `${top?.name || "Someone"} wins the game.`;
  }
  $("wildEntry").classList.toggle("hidden", !(state.state === "playing" && !state.isJudge && !state.submitted && state.roundRule === "wild"));
}

function renderHand(){
  const hand = $("hand");
  hand.innerHTML = "";
  $("submitSelectedBtn").classList.add("hidden");
  $("selectionHint").textContent = "";
  if(state.isJudge){
    hand.innerHTML = '<div class="small">You are judging this round and do not play a card.</div>';
    return;
  }
  const locked = state.submitted || state.state !== "playing";
  state.hand.forEach((text, index) => {
    const btn = document.createElement("button");
    btn.className = "answer-card" + (selectedIndices.includes(index) ? " selected" : "");
    btn.textContent = text;
    btn.disabled = locked;
    btn.addEventListener("click", () => toggleSelection(index));
    hand.appendChild(btn);
  });
  if(!locked){
    if(state.roundRule === "double"){
      $("selectionHint").textContent = `Select 2 cards (${selectedIndices.length}/2)`;
      $("submitSelectedBtn").classList.remove("hidden");
      $("submitSelectedBtn").disabled = selectedIndices.length !== 2;
    } else {
      $("selectionHint").textContent = "Click a card to submit it.";
    }
  }
}
function toggleSelection(index){
  if(state.submitted || state.state !== "playing" || state.isJudge) return;
  if(state.roundRule !== "double"){
    socket.emit("submitCards", { code: roomCode, indices: [index], wild: null });
    return;
  }
  const pos = selectedIndices.indexOf(index);
  if (pos >= 0) selectedIndices.splice(pos, 1);
  else if (selectedIndices.length < 2) selectedIndices.push(index);
  renderHand();
}
function submitSelected(){
  if(state.roundRule !== "double" || selectedIndices.length !== 2) return;
  socket.emit("submitCards", { code: roomCode, indices: selectedIndices, wild: null });
  selectedIndices = [];
}

function renderSubmissions(){
  const wrap = $("submissions");
  wrap.innerHTML = "";
  if(!["judging","voting","roundEnd"].includes(state.state)) return;
  state.submissions.forEach(s => {
    const card = document.createElement("button");
    card.className = "submission-card";
    card.textContent = s.text;
    if(state.state === "judging" && state.isJudge){
      card.classList.add("pickable");
      card.addEventListener("click", () => socket.emit("pickWinner", { code: roomCode, token: s.token }));
    } else if(state.state === "voting" && !state.voted && !s.isMine){
      card.classList.add("pickable");
      card.addEventListener("click", () => socket.emit("vote", { code: roomCode, token: s.token }));
    } else {
      card.disabled = true;
    }
    if(s.isMine) card.classList.add("mine");
    if(state.state === "roundEnd" && s.playerId === state.winnerId) card.classList.add("winner");
    if(state.state === "roundEnd" && Number.isFinite(s.votes)){
      const votes = document.createElement("span");
      votes.className = "vote-count";
      votes.textContent = `${s.votes} vote${s.votes === 1 ? "" : "s"}`;
      card.appendChild(votes);
    }
    wrap.appendChild(card);
  });
}

function renderRoundButtons(){
  $("nextRoundBtn").classList.toggle("hidden", !(state.state === "roundEnd" && state.isHost));
  $("restartBtn").classList.toggle("hidden", !(state.state === "gameOver" && state.isHost));
}
function stopTimer(){
  if(timerHandle){ clearInterval(timerHandle); timerHandle = null; }
  $("timer").classList.add("hidden");
}
function renderTimer(){
  stopTimer();
  if(!state.deadline || state.state !== "playing") return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    $("timer").textContent = `Bloodlust: ${left}s`;
    $("timer").classList.remove("hidden");
    if(left <= 0) stopTimer();
  };
  tick();
  timerHandle = setInterval(tick, 250);
}
