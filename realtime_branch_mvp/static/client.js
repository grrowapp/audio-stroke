"use strict";
// Plain JS UI. Model-generated strings are only ever inserted with textContent / value.

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k === "value") n.value = v;
    else if (k === "checked") n.checked = !!v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    const msg = typeof d === "string" ? d : d && d.message ? d.message + (d.missing ? `: ${d.missing.join(", ")}` : "") : `HTTP ${r.status}`;
    const err = new Error(msg);
    err.detail = d;
    throw err;
  }
  return data;
}

const S = {
  config: null,
  scenarioId: null,
  version: null,     // version shown in review
  row: null,         // version row
  draft: null,       // editable copy of row.scenario
  audioJob: null,
  readyVersion: null,
  sessionId: null,
};

// ------------------------------------------------------------------ config
async function loadConfig() {
  const c = await api("GET", "/api/config");
  S.config = c;
  const b = $("providerBadges");
  b.replaceChildren();
  const badge = (label, mock, extra) => el("span", { class: "badge " + (mock ? "mock" : "real"), text: `${label}: ${mock ? "MOCK" : extra}` });
  b.append(badge("分岐生成", c.providers.scenario.mock, `Claude ${c.providers.scenario.model}`));
  b.append(badge("音声生成", c.providers.tts.mock, c.providers.tts.name));
  b.append(badge("会話分類", c.providers.realtime.mock, `Realtime ${c.providers.realtime.model} / preview:${c.providers.realtime.preview_mode}`));
  $("fixedRules").replaceChildren(...c.fixed_rules.map((r) => el("li", { text: r })));
  const fill = (sel, items) => $(sel).replaceChildren(...items.map((x) => el("option", { value: x.id ?? x, text: x.label ?? x.id ?? x })));
  fill("vProvider", c.voice_options.providers);
  fill("vModel", c.voice_options.models);
  fill("vVoice", c.voice_options.voices);
  fill("vStyle", c.voice_options.styles.map((s) => ({ id: s.id, label: `${s.id}${s.text ? "：" + s.text.slice(0, 18) + "…" : ""}` })));
  $("vSpeed").min = c.voice_options.speed.min;
  $("vSpeed").max = c.voice_options.speed.max;
  $("vHint").textContent = `形式: ${c.voice_options.format}。音声生成（TTS）は分岐生成（Claude）とは別処理で、承認した版の発話文だけを音声化します。` +
    (c.voice_options.models.length ? "" : " ※TTS_MODEL/TTS_VOICE が未設定です。");
  $("inDepth").max = c.limits.max_depth;
  $("inNodes").max = c.limits.max_nodes;
  $("inBranches").max = c.limits.max_branches;
}

// ------------------------------------------------------------------ generation
async function pollJob(jobId, onUpdate) {
  for (;;) {
    const j = await api("GET", `/api/jobs/${jobId}`);
    onUpdate(j);
    if (["succeeded", "failed", "canceled", "interrupted"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function onGenerate() {
  const body = {
    instruction: $("inInstruction").value.trim(),
    facts: $("inFacts").value,
    prohibitions: $("inProhibitions").value,
    first_utterance: $("inFirst").value.trim(),
    max_depth: +$("inDepth").value, max_nodes: +$("inNodes").value, max_branches: +$("inBranches").value,
  };
  if (!body.instruction) { $("genStatus").textContent = "応対目的・指示を入力してください。"; return; }
  $("btnGenerate").disabled = true;
  try {
    const { job_id, mock } = await api("POST", "/api/scenarios/generate", body);
    $("genStatus").textContent = `生成ジョブ開始 (${mock ? "MOCK" : "Claude API"})`;
    const j = await pollJob(job_id, (j) => {
      $("genStatus").textContent = `GENERATING… ${j.status} ${j.progress.stage || ""}${mock ? "（MOCK）" : ""}`;
    });
    if (j.status !== "succeeded") {
      $("genStatus").textContent = `生成失敗: ${j.error || j.status}` + (j.result && j.result.details ? "\n" + [].concat(j.result.details).join("\n") : "");
      return;
    }
    const usage = (j.result.usage || []).map((u) => `in=${u.input_tokens ?? "-"} out=${u.output_tokens ?? "-"}`).join(", ");
    $("genStatus").textContent = `生成完了（${j.result.mock ? "MOCK" : j.result.model}、試行 ${j.result.attempts} 回、修復 ${j.result.repairs} 回${usage ? "、usage " + usage : ""}）`;
    S.scenarioId = j.result.scenario_id;
    await showVersion(j.result.version);
  } catch (e) {
    $("genStatus").textContent = "エラー: " + e.message;
  } finally {
    $("btnGenerate").disabled = false;
  }
}

// ------------------------------------------------------------------ review / edit
async function refreshVersionList(select) {
  const { versions } = await api("GET", `/api/scenarios/${S.scenarioId}/versions`);
  $("versionSelect").replaceChildren(...versions.map((v) => el("option", { value: v.version, text: `v${v.version} ${v.status}${v.parent_version ? " (v" + v.parent_version + "から編集)" : ""}` })));
  $("versionSelect").value = String(select);
}

async function showVersion(ver) {
  const row = await api("GET", `/api/scenarios/${S.scenarioId}/versions/${ver}`);
  S.version = ver;
  S.row = row;
  S.draft = JSON.parse(JSON.stringify(row.scenario));
  $("secReview").hidden = false;
  $("reviewVersion").textContent = `${row.scenario_id} v${ver}`;
  $("versionStatus").textContent = row.status;
  $("versionGenerator").textContent = row.is_mock_generated ? "MOCK生成" : row.generator === "edit" ? "手動編集" : "Claude生成";
  $("chkReviewed").checked = false;
  await refreshVersionList(ver);
  renderValidation(row.validation);
  $("designNotes").textContent = row.scenario.design_notes ? "設計メモ: " + row.scenario.design_notes : "";
  renderEditor();
  updateStartAvailability(row);
  if (row.status !== "REVIEW") await showAudio(ver);
}

function renderValidation(v) {
  const box = $("validationBox");
  box.replaceChildren();
  if (!v) return;
  box.append(el("div", { class: v.ok ? "ok" : "e", text: v.ok ? "グラフ検証: 合格" : `グラフ検証: エラー ${v.errors.length} 件` }));
  for (const e of v.errors) box.append(el("div", { class: "e", text: `✗ [${e.code}] ${e.message}` }));
  for (const w of v.warnings) box.append(el("div", { class: "w", text: `! [${w.code}] ${w.message}` }));
  if (v.stats) box.append(el("div", { class: "hint", text: `統計: ${JSON.stringify(v.stats)}` }));
}

function lines(arr) { return (arr || []).join("\n"); }
function unlines(s) { return s.split("\n").map((x) => x.trim()).filter(Boolean); }

function renderEditor() {
  const d = S.draft;
  const ed = $("editor");
  ed.replaceChildren();
  $("rawJson").value = JSON.stringify(d, null, 2);
  const nodeIds = d.nodes.map((n) => n.id);
  const ctrlIds = d.control_nodes.map((c) => c.id);
  const bind = (obj, key, input, conv = (x) => x) => {
    input.addEventListener("input", () => { obj[key] = conv(input.type === "checkbox" ? input.checked : input.value); syncRaw(); });
    return input;
  };
  const select = (obj, key, options, allowNull) => {
    const s = el("select");
    if (allowNull) s.append(el("option", { value: "", text: "（なし）" }));
    options.forEach((o) => s.append(el("option", { value: o, text: o })));
    s.value = obj[key] ?? "";
    s.addEventListener("change", () => { obj[key] = s.value || null; syncRaw(); });
    return s;
  };
  ed.append(el("label", {}, ["タイトル", bind(d, "title", el("input", { value: d.title }))]));
  ed.append(el("label", {}, ["入口ノード", select(d, "entry_node_id", nodeIds, false)]));
  for (const n of d.nodes) {
    const card = el("div", { class: "node" });
    card.append(el("h4", { text: `ノード ${n.id}${n.id === d.entry_node_id ? "（入口）" : ""}${n.terminal ? "（終端）" : ""}` }));
    card.append(el("label", {}, ["ラベル", bind(n, "label", el("input", { value: n.label }))]));
    card.append(el("label", {}, ["発話文（このノードに入った時に一度だけ再生）", bind(n, "assistant_text", el("textarea", { rows: 2, value: n.assistant_text }))]));
    card.append(el("label", { class: "check" }, [bind(n, "terminal", el("input", { type: "checkbox", checked: n.terminal })), "終端（再生後に会話を閉じる）"]));
    const row = el("div", { class: "row" });
    row.append(el("label", {}, ["fallback（聞き返し）", select(n, "fallback_node_id", ctrlIds, true)]));
    row.append(el("label", {}, ["no-input（無応答）", select(n, "no_input_node_id", ctrlIds, true)]));
    card.append(row);
    if (n.edges.length) {
      const t = el("table", { class: "edges" });
      t.append(el("tr", {}, ["ID", "ラベル/種別/遷移先", "意図・条件（1行1件）", "想定返答例", "否定例"].map((h) => el("th", { text: h }))));
      for (const e of n.edges) {
        const kind = el("select");
        ["normal", "confirm", "deny", "correction"].forEach((k) => kind.append(el("option", { value: k, text: k })));
        kind.value = e.kind;
        kind.addEventListener("change", () => { e.kind = kind.value; syncRaw(); });
        t.append(el("tr", {}, [
          el("td", { text: e.id }),
          el("td", {}, [bind(e, "label", el("input", { value: e.label })), kind, select(e, "target_node_id", nodeIds, false)]),
          el("td", {}, [bind(e, "intent_description", el("textarea", { value: e.intent_description })),
                        bind(e, "match_conditions", el("textarea", { value: lines(e.match_conditions) }), unlines)]),
          el("td", {}, [bind(e, "positive_examples", el("textarea", { value: lines(e.positive_examples) }), unlines)]),
          el("td", {}, [bind(e, "negative_examples", el("textarea", { value: lines(e.negative_examples) }), unlines)]),
        ]));
      }
      card.append(t);
      card.append(el("div", { class: "hint", text: "※ 全ノードで「終了希望」と「聞き取り不明（fallback）」はアプリが自動で受け付けます。" }));
    }
    ed.append(card);
  }
  for (const c of d.control_nodes) {
    const card = el("div", { class: "node control" });
    card.append(el("h4", { text: `制御ノード ${c.id}（${c.kind} / ${c.action}${c.goto_node_id ? " → " + c.goto_node_id : ""}）` }));
    card.append(el("label", {}, ["発話文", bind(c, "assistant_text", el("textarea", { rows: 2, value: c.assistant_text }))]));
    ed.append(card);
  }
  const pol = d.policy;
  const prow = el("div", { class: "row" });
  for (const k of ["max_turns", "max_clarify_per_node", "max_no_input_per_node", "no_input_timeout_ms"]) {
    prow.append(el("label", {}, [k, bind(pol, k, el("input", { type: "number", value: pol[k] }), Number)]));
  }
  ed.append(el("h4", { text: "ポリシー" }), prow);
}

function syncRaw() { $("rawJson").value = JSON.stringify(S.draft, null, 2); }

function draftBody() {
  const d = S.draft;
  const keys = ["title", "entry_node_id", "nodes", "control_nodes", "policy", "design_notes"];
  const out = {};
  keys.forEach((k) => (out[k] = d[k]));
  return out;
}

async function onValidate() {
  try {
    const v = await api("POST", `/api/scenarios/${S.scenarioId}/validate`, { base_version: S.version, scenario: draftBody() });
    renderValidation(v);
    $("reviewStatus").textContent = "検証しました（未保存）。";
  } catch (e) { $("reviewStatus").textContent = "エラー: " + e.message; }
}

async function onSaveVersion() {
  try {
    const row = await api("POST", `/api/scenarios/${S.scenarioId}/versions`, { base_version: S.version, scenario: draftBody() });
    $("reviewStatus").textContent = `v${row.version} として保存しました（実行中のセッションは元の版のままです）。`;
    await showVersion(row.version);
  } catch (e) {
    $("reviewStatus").textContent = "保存できません: " + e.message;
    if (e.detail && e.detail.validation) renderValidation(e.detail.validation);
  }
}

async function onApprove() {
  if (JSON.stringify(draftBody()) !== JSON.stringify((({ title, entry_node_id, nodes, control_nodes, policy, design_notes }) => ({ title, entry_node_id, nodes, control_nodes, policy, design_notes }))(S.row.scenario))) {
    $("reviewStatus").textContent = "未保存の編集があります。先に「新しい版として保存」してください（承認は保存済みの版に対して行います）。";
    return;
  }
  if (!$("chkReviewed").checked) { $("reviewStatus").textContent = "内容確認のチェックを入れてください。"; return; }
  const voice = { provider: $("vProvider").value, model: $("vModel").value, voice: $("vVoice").value, speed: +$("vSpeed").value, style_id: $("vStyle").value };
  try {
    const r = await api("POST", `/api/scenarios/${S.scenarioId}/versions/${S.version}/approve`, { voice, confirm_reviewed: true });
    $("reviewStatus").textContent = `v${S.version} を承認し音声生成を開始しました（${r.mock ? "MOCK音声" : "TTS"}、概算 ${r.summary.chars_to_generate} 文字、キャッシュ再利用 ${r.summary.cache_hits} 件）。`;
    S.audioJob = r.job_id;
    await showAudio(S.version);
    trackAudioJob(r.job_id);
  } catch (e) {
    $("reviewStatus").textContent = "承認できません: " + e.message;
    if (e.detail && e.detail.validation) renderValidation(e.detail.validation);
  }
}

// ------------------------------------------------------------------ audio
async function showAudio(ver) {
  $("secAudio").hidden = false;
  $("audioVersion").textContent = `v${ver}`;
  const m = await api("GET", `/api/scenarios/${S.scenarioId}/versions/${ver}/manifest`);
  const s = m.summary;
  $("audioProgress").textContent = `状態 ${m.status}${m.mock_audio ? "（MOCK音声：トーンのみ・発話ではありません）" : ""}\n` +
    `完了 ${s.ready}/${s.total}、失敗 ${s.failed}、未完了 ${s.pending}、キャッシュ再利用 ${s.cache_hits}、総文字数 ${s.chars}（生成対象 ${s.chars_to_generate ?? "-"}）`;
  const tb = $("audioTable").tBodies[0];
  tb.replaceChildren();
  for (const e of Object.values(m.entries || {})) {
    const play = el("button", { type: "button", class: "secondary", text: "再生" });
    play.disabled = e.status !== "ready";
    play.addEventListener("click", () => { new Audio(`/api/audio/${e.audio_id}`).play().catch((err) => alert("再生失敗: " + err)); });
    tb.append(el("tr", {}, [
      el("td", { text: e.utterance_key }), el("td", { text: e.text }),
      el("td", { text: e.status + (e.cache_hit ? "（キャッシュ）" : "") + (e.error ? `：${e.error}` : "") }),
      el("td", { text: e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : "" }), el("td", {}, [play]),
    ]));
  }
  const row = await api("GET", `/api/scenarios/${S.scenarioId}/versions/${ver}`);
  updateStartAvailability(row);
}

async function trackAudioJob(jobId) {
  const j = await pollJob(jobId, async (j) => {
    const p = j.progress || {};
    $("audioProgress").textContent = `AUDIO_PREPARING… 完了 ${p.done ?? 0}/${p.total ?? "?"}、失敗 ${p.failed ?? 0}、キャッシュ再利用 ${p.cache_hits ?? 0}、生成文字数 ${p.chars_to_generate ?? "-"}${p.mock ? "（MOCK）" : ""}`;
  });
  await showAudio(S.version);
  if (j.status !== "succeeded") $("audioProgress").textContent += `\nジョブ結果: ${j.status} ${j.error || ""}`;
}

async function onAudioCancel() {
  if (S.audioJob) await api("POST", `/api/jobs/${S.audioJob}/cancel`, {});
}

async function onAudioRetry() {
  try {
    const r = await api("POST", `/api/scenarios/${S.scenarioId}/versions/${S.version}/audio/retry`, {});
    S.audioJob = r.job_id;
    trackAudioJob(r.job_id);
  } catch (e) { $("audioProgress").textContent += "\n再試行できません: " + e.message; }
}

function updateStartAvailability(row) {
  $("secConv").hidden = false;
  const ready = row.status === "READY" && row.validation && row.validation.ok;
  $("btnStart").disabled = !ready || !!Conv.ws;
  S.readyVersion = ready ? row.version : null;
  $("convVersion").textContent = `v${row.version}`;
  $("startHint").textContent = ready ? `v${row.version} は READY です（開始時にサーバーで再確認します）。` :
    `v${row.version} は ${row.status} のため開始できません（承認・音声生成完了・検証合格が必要です）。`;
}

// ------------------------------------------------------------------ conversation
const Conv = {
  ws: null, ctx: null, node: null, stream: null, decoded: new Map(), playback: null,
  micEnabled: false, playing: false, mock: false, mockTimer: null, metrics: {},
  tPlayMsg: 0, tSpeechStopped: null, sessionId: null, branches: {}, manifest: {},
};

function logEvent(text) {
  const li = el("li", { text: `${new Date().toLocaleTimeString()} ${text}` });
  $("eventLog").prepend(li);
  while ($("eventLog").children.length > 200) $("eventLog").lastChild.remove();
}

function renderMetrics() {
  const defs = (S.config && S.config.metric_definitions) || {};
  const tb = $("metricsTable").tBodies[0];
  tb.replaceChildren(...Object.entries(defs).map(([k, d]) => el("tr", {}, [el("td", { text: k }), el("td", { text: Conv.metrics[k] != null ? String(Conv.metrics[k]) : "" }), el("td", { text: d })])));
}

function decodeAudio(audioId) {
  if (!/^[0-9a-f]{64}$/.test(audioId)) return Promise.reject(new Error("bad id"));
  if (!Conv.decoded.has(audioId)) {
    const p = fetch(`/api/audio/${audioId}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => Conv.ctx.decodeAudioData(buf));
    p.catch(() => Conv.decoded.delete(audioId));
    Conv.decoded.set(audioId, p);
  }
  return Conv.decoded.get(audioId);
}

function setMic() {
  const on = Conv.micEnabled && !Conv.playing;
  if (Conv.node) Conv.node.port.postMessage({ enabled: on && !Conv.mock });
  if (Conv.mock) {
    if (on && !Conv.mockTimer) {
      // MOCK mode: stream silence at real-time pace so buffering/preview timing is exercised.
      Conv.mockTimer = setInterval(() => { if (Conv.ws && Conv.ws.readyState === 1) Conv.ws.send(new Int16Array(480).buffer); }, 20);
    } else if (!on && Conv.mockTimer) { clearInterval(Conv.mockTimer); Conv.mockTimer = null; }
  }
  $("cMic").textContent = Conv.playing ? "再生中／マイク送信停止" : on ? (Conv.mock ? "送信中（MOCK無音）" : "送信中") : "停止";
}

function send(obj) { if (Conv.ws && Conv.ws.readyState === 1) Conv.ws.send(JSON.stringify(obj)); }

async function onStart() {
  if (Conv.ws || !S.readyVersion) return;
  $("btnStart").disabled = true;
  $("convError").textContent = "";
  $("eventLog").replaceChildren();
  Conv.metrics = {};
  renderMetrics();
  try {
    // user gesture: create/resume AudioContext first (autoplay policy)
    if (!Conv.ctx) Conv.ctx = new AudioContext({ sampleRate: 24000 });
    await Conv.ctx.resume();
    if (Conv.ctx.sampleRate !== 24000) throw new Error(`AudioContext が 24kHz になりません（${Conv.ctx.sampleRate}Hz）`);
    const runtime = {
      silence_duration_ms: +$("rsSilence").value, final_grace_ms: +$("rsGrace").value, preview_enabled: $("rsPreview").checked,
      preview_min_audio_ms: +$("rsPrevMin").value, preview_interval_ms: +$("rsPrevInt").value, preview_max_per_utterance: +$("rsPrevMax").value,
    };
    const sess = await api("POST", "/api/sessions", { scenario_id: S.scenarioId, version: S.readyVersion, request_id: crypto.randomUUID().replace(/-/g, ""), runtime });
    Conv.sessionId = sess.session_id;
    Conv.mock = sess.mock_realtime;
    Conv.manifest = sess.manifest;
    Conv.branches = sess.branches;
    $("mockPanel").hidden = !Conv.mock;
    $("convVersion").textContent = `v${sess.version}（このセッション中は固定）`;
    await decodeAudio(sess.entry_audio_id); // decode the first utterance before opening the session
    if (!Conv.mock) {
      Conv.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await Conv.ctx.audioWorklet.addModule("/static/worklet.js");
      const src = Conv.ctx.createMediaStreamSource(Conv.stream);
      Conv.node = new AudioWorkletNode(Conv.ctx, "pcm-capture");
      Conv.node.port.onmessage = (e) => { if (Conv.micEnabled && !Conv.playing && Conv.ws && Conv.ws.readyState === 1) Conv.ws.send(e.data); };
      src.connect(Conv.node);
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?session_id=${encodeURIComponent(sess.session_id)}`);
    ws.binaryType = "arraybuffer";
    Conv.ws = ws;
    ws.onmessage = (ev) => { try { onServer(JSON.parse(ev.data)); } catch (e) { logEvent("bad message " + e); } };
    ws.onclose = () => { logEvent("WebSocket closed"); cleanupConv(); };
    $("btnExport").disabled = false;
    logEvent(`session ${sess.session_id} v${sess.version}`);
  } catch (e) {
    $("convError").textContent = "開始できません: " + e.message;
    cleanupConv();
  }
}

function fillMockSelects(nodeId) {
  const opts = [...(Conv.branches[nodeId] || []), "ctrl_unclear", "ctrl_end_request", "invalid_branch_for_test"];
  for (const id of ["mockPreview", "mockFinal"]) {
    const s = $(id);
    const prev = s.value;
    s.replaceChildren(...opts.map((o) => el("option", { value: o, text: o })));
    if (opts.includes(prev)) s.value = prev;
  }
}

function onServer(m) {
  switch (m.type) {
    case "state":
      $("cPhase").textContent = m.phase + (m.speaking ? "（ユーザー発話中）" : "");
      $("cNode").textContent = `${m.node_label} (${m.node_id})  turn ${m.turn_id} / gen ${m.decision_generation}`;
      $("cText").textContent = m.playing_key ? (Conv.manifest[m.playing_key] || {}).text || "" : m.node_text;
      Conv.micEnabled = m.mic_enabled;
      setMic();
      $("counters").textContent = "counters: " + JSON.stringify(m.counters);
      $("btnRetryPlay").hidden = m.phase !== "PLAYBACK_ERROR";
      if (Conv.mock) fillMockSelects(m.node_id);
      break;
    case "prefetch": {
      const ids = m.audio_ids || [];
      let cached = 0;
      ids.forEach((id) => { if (Conv.decoded.has(id)) cached++; decodeAudio(id).catch(() => {}); });
      $("cCache").textContent = `候補 ${ids.length} 件（既読込 ${cached}）`;
      break;
    }
    case "play": playAudio(m); break;
    case "speech_started": $("cPreview").textContent = "（発話中…）"; $("cFinal").textContent = ""; $("cNext").textContent = ""; logEvent("speech_started"); break;
    case "speech_stopped": Conv.tSpeechStopped = performance.now(); logEvent("speech_stopped"); break;
    case "preview": $("cPreview").textContent = `${m.label} [${m.branch_id}]（暫定・再生には使いません）`; logEvent(`preview ${m.branch_id}`); break;
    case "final":
      $("cFinal").textContent = `${m.label} [${m.branch_id}]${m.fallback_reason ? " fallback:" + m.fallback_reason : ""}`;
      $("cNext").textContent = m.next_text;
      logEvent(`final ${m.branch_id}${m.fallback_reason ? " (" + m.fallback_reason + ")" : ""}`);
      break;
    case "final_invalidated": $("cFinal").textContent = `（再発話のため無効化: ${m.reason}）`; logEvent("final invalidated"); break;
    case "metric": Conv.metrics[m.name] = m.value_ms; renderMetrics(); break;
    case "playback_error": $("convError").textContent = m.message; logEvent("playback_error"); break;
    case "finished":
      logEvent(`finished ${m.phase} ${m.reason}`);
      if (m.phase !== "FINISHED") $("convError").textContent = m.message || m.reason;
      else $("cPhase").textContent = "FINISHED";
      if (m.realtime_usage) $("counters").textContent += `\nRealtime usage: ${JSON.stringify(m.realtime_usage)}`;
      break;
    default: logEvent("? " + m.type);
  }
}

async function playAudio(m) {
  Conv.tPlayMsg = performance.now();
  stopCurrentSource(false);
  Conv.playing = true;
  setMic();
  const pb = { id: m.playback_id, src: null, startedAt: 0, canceled: false };
  Conv.playback = pb;
  $("cText").textContent = m.text;
  logEvent(`play ${m.utterance_key}`);
  let buf;
  try {
    buf = await decodeAudio(m.audio_id);
  } catch (e) {
    if (Conv.playback !== pb) return;
    Conv.playing = false; setMic();
    send({ type: "playback_failed", playback_id: pb.id, error: "decode/load: " + e.message });
    return;
  }
  if (Conv.playback !== pb) return; // superseded
  try {
    if (Conv.ctx.state !== "running") await Conv.ctx.resume();
    const src = Conv.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(Conv.ctx.destination);
    src.onended = () => {
      if (Conv.playback !== pb || pb.canceled) return; // stale ended never opens a new turn
      Conv.playback = null;
      Conv.playing = false;
      setMic();
      send({ type: "playback_ended", playback_id: pb.id });
    };
    src.start();
    pb.src = src;
    pb.startedAt = performance.now();
    send({ type: "playback_started", playback_id: pb.id });
    const v = Math.round(pb.startedAt - Conv.tPlayMsg);
    Conv.metrics.decision_message_to_playback_started_ms = v;
    send({ type: "client_metric", name: "decision_message_to_playback_started_ms", value_ms: v, playback_id: pb.id, turn_id: m.turn_id });
    if (Conv.tSpeechStopped != null) {
      const v2 = Math.round(pb.startedAt - Conv.tSpeechStopped);
      Conv.metrics.client_notification_speech_stopped_to_playback_started_ms = v2;
      send({ type: "client_metric", name: "client_notification_speech_stopped_to_playback_started_ms", value_ms: v2, playback_id: pb.id, turn_id: m.turn_id });
      Conv.tSpeechStopped = null;
    }
    renderMetrics();
  } catch (e) {
    Conv.playing = false; setMic();
    send({ type: "playback_failed", playback_id: pb.id, error: "play: " + e.message });
  }
}

function stopCurrentSource(report) {
  const pb = Conv.playback;
  if (!pb) return;
  pb.canceled = true;
  try { if (pb.src) pb.src.stop(); } catch (_) { /* already stopped */ }
  if (report) send({ type: "playback_canceled", playback_id: pb.id, reason: "user_skip", position_ms: Math.round(performance.now() - pb.startedAt) });
  Conv.playback = null;
  Conv.playing = false;
  setMic();
}

function cleanupConv() {
  stopCurrentSource(false);
  if (Conv.mockTimer) { clearInterval(Conv.mockTimer); Conv.mockTimer = null; }
  if (Conv.stream) { Conv.stream.getTracks().forEach((t) => t.stop()); Conv.stream = null; }
  if (Conv.node) { Conv.node.disconnect(); Conv.node = null; }
  if (Conv.ws && Conv.ws.readyState <= 1) Conv.ws.close();
  Conv.ws = null;
  Conv.micEnabled = false;
  setMic();
  $("btnStart").disabled = !S.readyVersion;
}

// ------------------------------------------------------------------ wire up
window.addEventListener("DOMContentLoaded", async () => {
  try { await loadConfig(); } catch (e) { $("genStatus").textContent = "設定取得失敗: " + e.message; }
  renderMetrics();
  setMic();
  $("btnSample").addEventListener("click", () => { $("inInstruction").value = S.config ? S.config.sample_instruction : ""; });
  $("btnGenerate").addEventListener("click", onGenerate);
  $("versionSelect").addEventListener("change", () => showVersion(+$("versionSelect").value));
  $("btnValidate").addEventListener("click", onValidate);
  $("btnSaveVersion").addEventListener("click", onSaveVersion);
  $("btnApprove").addEventListener("click", onApprove);
  $("btnRawApply").addEventListener("click", () => {
    try { S.draft = JSON.parse($("rawJson").value); renderEditor(); $("reviewStatus").textContent = "JSON を反映しました（未保存）。"; }
    catch (e) { $("reviewStatus").textContent = "JSON が不正です: " + e.message; }
  });
  $("btnAudioCancel").addEventListener("click", onAudioCancel);
  $("btnAudioRetry").addEventListener("click", onAudioRetry);
  $("btnStart").addEventListener("click", onStart);
  $("btnStop").addEventListener("click", () => { send({ type: "stop" }); stopCurrentSource(false); });
  $("btnSkip").addEventListener("click", () => stopCurrentSource(true));
  $("btnRetryPlay").addEventListener("click", () => { $("convError").textContent = ""; send({ type: "playback_retry" }); });
  $("btnMockStart").addEventListener("click", () => send({ type: "mock_vad", action: "start", preview_branch: $("mockPreview").value, final_branch: $("mockFinal").value }));
  $("btnMockStop").addEventListener("click", () => send({ type: "mock_vad", action: "stop", preview_branch: $("mockPreview").value, final_branch: $("mockFinal").value }));
  $("btnExport").addEventListener("click", () => {
    if (!Conv.sessionId) return;
    if (!confirm("評価ログには音声・全文文字起こしは含みませんが、ID・タイミング・分岐選択・エラー等から個人に関わる情報が推測される可能性があります。ダウンロードしますか？")) return;
    location.href = `/api/sessions/${Conv.sessionId}/log.jsonl`;
  });
});
