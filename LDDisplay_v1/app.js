// =====================================================================
//  LDDisplay Serial Control (Web · Android Test)   v0.2.0
//  Web Serial API + web-serial-polyfill(WebUSB) 이중 백엔드.
//    - 자동 선택: 모바일=폴리필 / PC=네이티브. 상단 드롭다운으로 수동 전환 가능.
//    - 8-N-1 / DTR=RTS=false / CR+LF (Python GUI와 동일)
//    - 연결 시 ESP32 부팅(~1.5s)을 감안해 ver 프로브를 700ms 간격으로
//      최대 3.5초까지 재시도. 응답 없으면 실패로 간주.
//    - 응답 라인 파서: version / brightness / font / scroll / siren / color / OK / invalid …
// =====================================================================

// ── 상수 ────────────────────────────────────────────────────────────
const LINE_ENDING = "\r\n";
// ESP32는 포트 오픈 시 DTR 펄스로 리셋 → 부팅에 ~1~1.5초 소요.
// Web Serial은 open 전에 DTR/RTS를 낮출 수 없어 리셋을 피할 수 없다.
// 첫 ver는 정상 송신 후, 응답이 없으면 짧은 간격으로 조용히 재시도.
const VER_PROBE_RETRY_MS = 700;
const VER_PROBE_TOTAL_MS = 3500;

const BRIGHT_SAFE_MAX = 150;
const BRIGHT_HARD_MAX = 255;

// 펌웨어 내장 패스워드(.ino의 FW_VER_PASSWORD)와 동일 — UI 게이트용 로컬 검증.
// 보안 보장은 펌웨어 setver 자체 검증이 함.
const FW_VER_PASSWORD = "Ekdls7194";

// 색상 상태 (펌웨어 CS_RUN/STOP/ES/ABN와 동기)
const COLOR_STATES = [
  { tag: "run",  label: "운전중 · 수동활선",     def: [255,   0,   0] },
  { tag: "stop", label: "정지중 · 수동휴전",     def: [  0, 255,  80] },
  { tag: "es",   label: "정지중(ES) · 조작시험", def: [255, 255,   0] },
  { tag: "abn",  label: "비정상",                def: [ 64,  64,  64] },
];

// ── DOM 캐시 ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  unsupported: $("unsupported"),
  apiSelect: $("api-select"),
  apiCurrent: $("api-current"),
  fwVer: $("fw-ver"),
  pickPort: $("btn-pick-port"),
  portName: $("port-name"),
  baud: $("baud-select"),
  connect: $("btn-connect"),
  lamp: $("lamp"),
  lampLabel: $("lamp-label"),
  rxLog: $("rx-log"),
  clearRx: $("btn-clear-rx"),
  txInput: $("tx-input"),
  txSend: $("btn-tx-send"),
  tabBtns: document.querySelectorAll(".tab-btn"),
  tabPanels: document.querySelectorAll(".tab-panel"),
  sirenTabBtn: document.querySelector('.tab-btn[data-tab="siren"]'),
  sirenTabPanel: document.querySelector('.tab-panel[data-tab="siren"]'),
  // 기본 탭
  brightScale: $("bright-scale"),
  brightVal: $("bright-val"),
  brightMax: $("bright-max"),
  brightAllowHigh: $("bright-allow-high"),
  brightApply: $("bright-apply"),
  fontBold: $("font-bold"),
  fontNormal: $("font-normal"),
  scrollDown: $("scroll-down"),
  scrollUp: $("scroll-up"),
  scrollVal: $("scroll-val"),
  // 사이렌 탭
  tonEntry: $("ton-entry"),
  tonApply: $("ton-apply"),
  toffEntry: $("toff-entry"),
  toffApply: $("toff-apply"),
  volScale: $("vol-scale"),
  volVal: $("vol-val"),
  volApply: $("vol-apply"),
  // 색상 탭
  colorRows: $("color-rows"),
  colorReload: $("color-reload"),
  colorDefault: $("color-default"),
  colorSaveAll: $("color-saveall"),
  // FW 버전 탭
  pwEntry: $("pw-entry"),
  pwVerify: $("pw-verify"),
  pwStatus: $("pw-status"),
  newverEntry: $("newver-entry"),
  setverApply: $("setver-apply"),
  setverStatus: $("setver-status"),
};

// ── 상태 ────────────────────────────────────────────────────────────
const state = {
  port: null,           // SerialPort
  reader: null,         // ReadableStreamDefaultReader
  writer: null,         // WritableStreamDefaultWriter
  readLoopDone: null,   // Promise — 읽기 루프 종료 대기용
  verified: false,      // ver 응답 수신 여부
  verTimer: null,       // ver 프로브 타임아웃 핸들
  rxBuf: "",            // 라인 조립용 버퍼
  scroll: 3,            // 현재 스크롤 값 (1~5)
  font: "bold",         // 현재 폰트
  pwVerified: false,    // FW 버전 패스워드 로컬 검증 통과 여부
  setverPending: false, // setver 응답 대기 중
  colorRows: [],        // 색상 행 상태
};

// ── 시리얼 API 선택 (네이티브 / CH340 / 폴리필 / 자동) ──────────────
//   window.ch340Serial    = ch340-driver.js — CH340 벤더 프로토콜 자체 드라이버
//   window.serialPolyfill = serial-polyfill.js — CDC-ACM 표준 장치용 폴리필 (참고용)
//   자동:
//     - 모바일 + ch340 드라이버 로드됨 → CH340 우선 (이 프로젝트 보드가 CH340)
//     - PC → 네이티브 Web Serial
let serialApi = null;

function pickSerialApi(mode) {
  const nativeAvail = "serial" in navigator;
  const ch340Avail  = !!window.ch340Serial;
  const polyAvail   = !!window.serialPolyfill;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  let choice, label;
  if (mode === "native") {
    choice = nativeAvail ? navigator.serial : null;
    label = "네이티브 Web Serial";
  } else if (mode === "ch340") {
    choice = ch340Avail ? window.ch340Serial : null;
    label = "CH340 (WebUSB)";
  } else if (mode === "polyfill") {
    choice = polyAvail ? window.serialPolyfill : null;
    label = "CDC-ACM 폴리필";
  } else {
    // auto
    if (isMobile && ch340Avail) { choice = window.ch340Serial;    label = "CH340 (자동 · 모바일)"; }
    else if (nativeAvail)       { choice = navigator.serial;      label = "네이티브 (자동 · PC)"; }
    else if (ch340Avail)        { choice = window.ch340Serial;    label = "CH340 (자동 · 폴백)"; }
    else if (polyAvail)         { choice = window.serialPolyfill; label = "CDC-ACM 폴리필 (자동 · 폴백)"; }
    else                        { choice = null;                  label = "미지원"; }
  }
  serialApi = choice;
  els.apiCurrent.textContent = "▶ " + label;

  if (!serialApi) {
    els.unsupported.hidden = false;
    els.pickPort.disabled = true;
  } else {
    els.unsupported.hidden = true;
    // 이미 포트가 선택돼 있지 않을 때만 pickPort 활성
    if (!state.port) els.pickPort.disabled = false;
  }
}

els.apiSelect.addEventListener("change", async () => {
  // 전환 시 연결 중이면 안전하게 해제하고 상태 리셋.
  if (state.port && state.reader) await disconnect();
  state.port = null;
  els.portName.textContent = "(선택 안 됨)";
  els.connect.disabled = true;
  pickSerialApi(els.apiSelect.value);
});

pickSerialApi("auto");

// ── 램프 / 컨트롤 상태 ───────────────────────────────────────────────
function setLamp(kind) {
  const labels = { off: "미연결", wait: "확인중", on: "연결됨", error: "오류" };
  els.lamp.dataset.state = kind;
  els.lampLabel.textContent = labels[kind] || "";
  els.lampLabel.dataset.state = kind;
}

// 포트 열림 상태 — connect 버튼 문구, TX 송신, 포트/보레이트 변경 잠금.
function setPortLive(live) {
  els.txSend.disabled = !live;
  els.connect.textContent = live ? "해제" : "연결";
  els.baud.disabled = live;
  els.pickPort.disabled = live;
}

// ver 응답으로 확정된 정상 연결. 탭 컨트롤은 여기서만 활성.
function setVerified(v) {
  const tabCtrls = [
    els.brightScale, els.brightAllowHigh, els.brightApply,
    els.fontBold, els.fontNormal,
    els.scrollDown, els.scrollUp,
    els.tonEntry, els.tonApply, els.toffEntry, els.toffApply,
    els.volScale, els.volApply,
    els.colorReload, els.colorDefault, els.colorSaveAll,
  ];
  for (const w of tabCtrls) w.disabled = !v;
  for (const row of state.colorRows) {
    row.r.disabled = !v;
    row.g.disabled = !v;
    row.b.disabled = !v;
    row.apply.disabled = !v;
  }
  if (v) {
    updateScrollButtons();
  } else {
    setSirenTabVisible(false);
    setverStatus("", null);
    state.setverPending = false;
  }
  applyPwGate();
}

// 사이렌 탭 표시/숨김
function setSirenTabVisible(visible) {
  els.sirenTabBtn.hidden = !visible;
  // 현재 사이렌 탭이 활성인데 숨겨졌으면 기본 탭으로 이동
  if (!visible && els.sirenTabPanel.classList.contains("active")) {
    switchTab("basic");
  }
}

function switchTab(name) {
  els.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  els.tabPanels.forEach((p) => p.classList.toggle("active", p.dataset.tab === name));
}

// ver 문자열에서 사이렌 탭 표시 여부 결정.
// FW 컨벤션: (major,minor)==(0,1)이면 사이렌 없음, 그 외 표시.
function applyVersionFeatures(ver) {
  const m = ver.match(/^\s*(\d+)\.(\d+)/);
  const noSiren = !!m && parseInt(m[1], 10) === 0 && parseInt(m[2], 10) === 1;
  setSirenTabVisible(!noSiren);
}

// ── RX 로그 ─────────────────────────────────────────────────────────
function rxAppend(text, kind) {
  const atBottom = els.rxLog.scrollTop + els.rxLog.clientHeight >= els.rxLog.scrollHeight - 4;
  const ts = new Date();
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");

  const line = document.createElement("div");
  const tsSpan = document.createElement("span");
  tsSpan.className = "rx-ts";
  tsSpan.textContent = `[${hh}:${mm}:${ss}] `;
  line.appendChild(tsSpan);

  const body = document.createElement("span");
  if (kind) body.className = "rx-" + kind;
  body.textContent = text;
  line.appendChild(body);

  els.rxLog.appendChild(line);
  if (atBottom) els.rxLog.scrollTop = els.rxLog.scrollHeight;
}

els.clearRx.addEventListener("click", () => { els.rxLog.textContent = ""; });

// ── 포트 선택 ────────────────────────────────────────────────────────
els.pickPort.addEventListener("click", async () => {
  if (!serialApi) return;
  try {
    const port = await serialApi.requestPort();
    state.port = port;
    // Web Serial은 포트 이름을 직접 노출하지 않음 — USB vendor/product ID로 힌트.
    els.portName.textContent = describePort(port);
    els.connect.disabled = false;
  } catch (e) {
    if (e.name !== "NotFoundError") rxAppend(`[포트 선택 오류] ${e.message}`, "err");
  }
});

function describePort(port) {
  const info = port.getInfo ? port.getInfo() : {};
  const vid = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, "0") : "?";
  const pid = info.usbProductId ? info.usbProductId.toString(16).padStart(4, "0") : "?";
  return `USB ${vid}:${pid}`;
}

// ── 연결 / 해제 ─────────────────────────────────────────────────────
els.connect.addEventListener("click", async () => {
  if (state.port && state.reader) {
    await disconnect();
  } else {
    await connect();
  }
});

async function connect() {
  if (!state.port) return;
  try {
    await state.port.open({
      baudRate: parseInt(els.baud.value, 10),
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
    // DTR/RTS off — 자동 리셋 방지.
    try {
      await state.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (_) { /* 일부 드라이버는 지원 안 함 — 무시 */ }

    state.writer = state.port.writable.getWriter();
    state.verified = false;
    setLamp("wait");
    setPortLive(true);       // 포트는 열림 — TX 송신은 가능(수동 명령 허용)
    setVerified(false);      // 탭 컨트롤은 아직 잠금

    // 읽기 루프 시작
    state.readLoopDone = readLoop();

    rxAppend(`[포트 열림] ${describePort(state.port)} @ ${els.baud.value} 8-N-1 — 부팅/응답 대기 (~2초)`, "info");
    await sendCommand("ver");
    // 부팅 중 첫 ver는 유실될 수 있어 조용히 재시도.
    const deadline = Date.now() + VER_PROBE_TOTAL_MS;
    const retryProbe = async () => {
      state.verTimer = null;
      if (state.verified || !state.writer) return;
      if (Date.now() >= deadline) {
        rxAppend("[연결 실패] 보드 응답 없음(ver 무응답) — 포트/연결/보레이트 확인", "err");
        setLamp("error");
        await disconnect();
        return;
      }
      await sendCommand("ver", { silent: true });
      state.verTimer = setTimeout(retryProbe, VER_PROBE_RETRY_MS);
    };
    state.verTimer = setTimeout(retryProbe, VER_PROBE_RETRY_MS);
  } catch (e) {
    rxAppend(`[연결 실패] ${e.message}`, "err");
    setLamp("error");
    setPortLive(false);
    setVerified(false);
    // 열지 못했으니 정리 필요 없음.
  }
}

async function disconnect() {
  if (state.verTimer) { clearTimeout(state.verTimer); state.verTimer = null; }

  if (state.reader) {
    try { await state.reader.cancel(); } catch (_) {}
  }
  if (state.readLoopDone) {
    try { await state.readLoopDone; } catch (_) {}
    state.readLoopDone = null;
  }
  if (state.writer) {
    try { state.writer.releaseLock(); } catch (_) {}
    state.writer = null;
  }
  if (state.port) {
    try { await state.port.close(); } catch (_) {}
  }
  state.reader = null;
  state.verified = false;
  state.rxBuf = "";

  setLamp("off");
  setPortLive(false);
  setVerified(false);
  els.fwVer.textContent = "ver.----";
  rxAppend("[해제]", "info");
}

// ── 읽기 루프 ────────────────────────────────────────────────────────
async function readLoop() {
  const textDecoder = new TextDecoderStream();
  const readableClosed = state.port.readable.pipeTo(textDecoder.writable).catch(() => {});
  const reader = textDecoder.readable.getReader();
  state.reader = reader;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      state.rxBuf += value;
      let idx;
      while ((idx = state.rxBuf.indexOf("\n")) >= 0) {
        const line = state.rxBuf.slice(0, idx).replace(/\r$/, "");
        state.rxBuf = state.rxBuf.slice(idx + 1);
        onLine(line);
      }
    }
  } catch (e) {
    rxAppend(`[수신 오류] ${e.message}`, "err");
    setLamp("error");
  } finally {
    try { reader.releaseLock(); } catch (_) {}
    await readableClosed;
  }
}

// ── 수신 라인 처리 ──────────────────────────────────────────────────
function onLine(line) {
  rxAppend(line);
  parseLine(line);
}

function parseLine(line) {
  const s = line.trim();

  // setver 응답(송신 후 첫 OK/invalid) — 'version:' 라인 매칭보다 먼저.
  if (state.setverPending) {
    if (s.startsWith("OK: version")) {
      setverStatus("쓰기 완료", "ok");
      state.setverPending = false;
      // 후속 'version:' 라인이 헤더/사이렌탭 갱신을 이어감.
    } else if (s.startsWith("invalid command")) {
      setverStatus("실패 — 비밀번호/형식 확인", "err");
      state.setverPending = false;
    }
  }

  let m;
  // version: 0.2.0 → 정상연결 확정 + FW 표시/사이렌 탭 갱신
  if ((m = s.match(/^version:\s*(\S+)/))) {
    els.fwVer.textContent = "ver." + m[1];
    applyVersionFeatures(m[1]);
    onVerified();
    return;
  }
  if ((m = s.match(/^brightness:\s*(\d+)/))) {
    syncBrightness(parseInt(m[1], 10));
    return;
  }
  if ((m = s.match(/^font:\s*(bold|normal)/))) {
    state.font = m[1];
    refreshFontButtons();
    return;
  }
  if ((m = s.match(/^scroll:\s*(\d+)/))) {
    state.scroll = Math.max(1, Math.min(5, parseInt(m[1], 10)));
    els.scrollVal.textContent = String(state.scroll);
    updateScrollButtons();
    return;
  }
  if ((m = s.match(/^siren ton\D*(\d+)/))) {
    els.tonEntry.value = m[1];
    return;
  }
  if ((m = s.match(/^siren toff\D*(\d+)/))) {
    els.toffEntry.value = m[1];
    return;
  }
  if ((m = s.match(/^siren vol:\s*(\d+)/))) {
    const v = Math.max(1, Math.min(50, parseInt(m[1], 10)));
    els.volScale.value = String(v);
    els.volVal.textContent = String(v);
    return;
  }
  // 색상 현재값 라인 — status/getcolor 응답 공용
  if ((m = s.match(/^color\s+(\w+):\s*(\d+)\s+(\d+)\s+(\d+)/))) {
    const row = state.colorRows.find((r) => r.tag === m[1]);
    if (row) {
      const r = clampByte(m[2]), g = clampByte(m[3]), b = clampByte(m[4]);
      setRowRgb(row, r, g, b);
      row.saved = [r, g, b];
      updateRowStatus(row);
    }
    return;
  }
  // setcolor 성공 응답 → 해당 행의 saved 갱신
  if ((m = s.match(/^OK:\s*setcolor\s+(\w+)\s+(\d+)\s+(\d+)\s+(\d+)/))) {
    const row = state.colorRows.find((r) => r.tag === m[1]);
    if (row) {
      const r = parseInt(m[2], 10), g = parseInt(m[3], 10), b = parseInt(m[4], 10);
      row.saved = [r, g, b];
      row.committed = [r, g, b];
      updateRowStatus(row);
    }
    return;
  }
}

// =====================================================================
// ── 기본 탭 — 밝기 / 폰트 / 스크롤 ──────────────────────────────────
// =====================================================================
function syncBrightness(val) {
  val = Math.max(0, Math.min(BRIGHT_HARD_MAX, val));
  if (val > BRIGHT_SAFE_MAX && !els.brightAllowHigh.checked) {
    els.brightAllowHigh.checked = true;
    els.brightScale.max = BRIGHT_HARD_MAX;
    els.brightMax.textContent = String(BRIGHT_HARD_MAX);
  }
  els.brightScale.value = String(val);
  els.brightVal.textContent = String(val);
}

els.brightScale.addEventListener("input", () => {
  els.brightVal.textContent = els.brightScale.value;
});
els.brightAllowHigh.addEventListener("change", () => {
  if (els.brightAllowHigh.checked) {
    els.brightScale.max = BRIGHT_HARD_MAX;
    els.brightMax.textContent = String(BRIGHT_HARD_MAX);
  } else {
    els.brightScale.max = BRIGHT_SAFE_MAX;
    els.brightMax.textContent = String(BRIGHT_SAFE_MAX);
    if (parseInt(els.brightScale.value, 10) > BRIGHT_SAFE_MAX) {
      els.brightScale.value = String(BRIGHT_SAFE_MAX);
      els.brightVal.textContent = String(BRIGHT_SAFE_MAX);
    }
  }
});
els.brightApply.addEventListener("click", () => {
  sendCommand(`bright ${parseInt(els.brightScale.value, 10)}`);
});

function refreshFontButtons() {
  els.fontBold.classList.toggle("active", state.font === "bold");
  els.fontNormal.classList.toggle("active", state.font === "normal");
}
els.fontBold.addEventListener("click", () => {
  state.font = "bold";
  refreshFontButtons();
  sendCommand("font bold");
});
els.fontNormal.addEventListener("click", () => {
  state.font = "normal";
  refreshFontButtons();
  sendCommand("font normal");
});
refreshFontButtons();

function stepScroll(delta) {
  const v = Math.max(1, Math.min(5, state.scroll + delta));
  if (v === state.scroll) return;
  state.scroll = v;
  els.scrollVal.textContent = String(v);
  updateScrollButtons();
  sendCommand(`scroll ${v}`);
}
function updateScrollButtons() {
  // 연결 상태와 한계값 둘 다 반영. 연결 안 됐으면 setConnected가 이미 disabled로 만듦.
  if (!state.writer) return;
  els.scrollDown.disabled = state.scroll <= 1;
  els.scrollUp.disabled = state.scroll >= 5;
}
els.scrollDown.addEventListener("click", () => stepScroll(-1));
els.scrollUp.addEventListener("click", () => stepScroll(+1));

// =====================================================================
// ── 사이렌 탭 — ton / toff / vol ───────────────────────────────────
// =====================================================================
els.tonApply.addEventListener("click", () => applyEntryCmd("ton", els.tonEntry));
els.toffApply.addEventListener("click", () => applyEntryCmd("toff", els.toffEntry));
els.tonEntry.addEventListener("keydown", (e) => { if (e.key === "Enter") applyEntryCmd("ton", els.tonEntry); });
els.toffEntry.addEventListener("keydown", (e) => { if (e.key === "Enter") applyEntryCmd("toff", els.toffEntry); });

function applyEntryCmd(cmd, entry) {
  const v = entry.value.trim();
  if (v) sendCommand(`${cmd} ${v}`);
}

els.volScale.addEventListener("input", () => {
  els.volVal.textContent = els.volScale.value;
});
els.volApply.addEventListener("click", () => {
  sendCommand(`vol ${parseInt(els.volScale.value, 10)}`);
});

// =====================================================================
// ── 색상 탭 — run/stop/es/abn RGB ───────────────────────────────────
// =====================================================================
function clampByte(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, n));
}
function toHexColor([r, g, b]) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function buildColorRows() {
  const frag = document.createDocumentFragment();
  for (const state_ of COLOR_STATES) {
    const [r, g, b] = state_.def;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="c-label">${state_.label}</td>
      <td><input type="number" min="0" max="255" value="${r}" disabled></td>
      <td><input type="number" min="0" max="255" value="${g}" disabled></td>
      <td><input type="number" min="0" max="255" value="${b}" disabled></td>
      <td><button class="row-apply" disabled>설정</button></td>
      <td><span class="color-swatch" style="background:${toHexColor(state_.def)}"></span></td>
      <td><span class="color-status">저장됨</span></td>
    `;
    const [rEl, gEl, bEl] = tr.querySelectorAll("input");
    const applyBtn = tr.querySelector(".row-apply");
    const swatch = tr.querySelector(".color-swatch");
    const status = tr.querySelector(".color-status");

    const row = {
      tag: state_.tag, label: state_.label, def: state_.def,
      r: rEl, g: gEl, b: bEl, apply: applyBtn, swatch, status,
      committed: [...state_.def], saved: [...state_.def],
    };
    state.colorRows.push(row);

    const onInput = () => {
      const cur = readRowInput(row);
      swatch.style.background = toHexColor(cur);
      updateRowStatus(row);
    };
    [rEl, gEl, bEl].forEach((e) => e.addEventListener("input", onInput));
    applyBtn.addEventListener("click", () => applyColorRow(row));
    frag.appendChild(tr);
  }
  els.colorRows.appendChild(frag);
}

function readRowInput(row) {
  return [clampByte(row.r.value), clampByte(row.g.value), clampByte(row.b.value)];
}
function setRowRgb(row, r, g, b) {
  row.r.value = String(r);
  row.g.value = String(g);
  row.b.value = String(b);
  row.swatch.style.background = toHexColor([r, g, b]);
  row.committed = [r, g, b];
  updateRowStatus(row);
}
function applyColorRow(row) {
  const cur = readRowInput(row);
  // 입력값이 원래 문자열과 다르면(범위 초과 등) 클램프된 값으로 되돌림.
  row.r.value = String(cur[0]); row.g.value = String(cur[1]); row.b.value = String(cur[2]);
  row.committed = cur;
  row.swatch.style.background = toHexColor(cur);
  updateRowStatus(row);
}
function eq3(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }
function updateRowStatus(row) {
  const cur = readRowInput(row);
  if (!eq3(cur, row.committed)) {
    row.status.textContent = "편집중";
    row.status.dataset.state = "wait";
  } else if (!eq3(row.committed, row.saved)) {
    row.status.textContent = "저장 대기";
    row.status.dataset.state = "wait";
  } else {
    row.status.textContent = "저장됨";
    row.status.dataset.state = "ok";
  }
}

els.colorReload.addEventListener("click", () => {
  if (state.verified) sendCommand("getcolor");
});
els.colorDefault.addEventListener("click", () => {
  for (const row of state.colorRows) setRowRgb(row, ...row.def);
});
els.colorSaveAll.addEventListener("click", () => {
  if (!state.verified) return;
  for (const row of state.colorRows) {
    const [r, g, b] = row.committed;
    sendCommand(`setcolor ${row.tag} ${r} ${g} ${b}`);
  }
});

// =====================================================================
// ── FW 버전 탭 — 비밀번호 게이트 + setver ──────────────────────────
// =====================================================================
function setPwStatus(text, kind) {
  els.pwStatus.textContent = text;
  if (kind) els.pwStatus.dataset.state = kind;
  else delete els.pwStatus.dataset.state;
}
function setverStatus(text, kind) {
  els.setverStatus.textContent = text;
  if (kind) els.setverStatus.dataset.state = kind;
  else delete els.setverStatus.dataset.state;
}
function applyPwGate() {
  // 새 버전 입력/적용은 (연결 확인 + 패스워드 검증) 모두 충족 시 활성.
  const enable = state.verified && state.pwVerified;
  els.newverEntry.disabled = !enable;
  els.setverApply.disabled = !enable;
}
els.pwVerify.addEventListener("click", verifyPassword);
els.pwEntry.addEventListener("keydown", (e) => { if (e.key === "Enter") verifyPassword(); });
function verifyPassword() {
  // 로컬 검증(오프라인 가능). 통과 시 세션 동안 유지 — 연결이 끊겨도 pwVerified 보존.
  const pw = els.pwEntry.value.trim();
  if (pw === FW_VER_PASSWORD) {
    state.pwVerified = true;
    setPwStatus("확인됨", "ok");
  } else {
    setPwStatus("비밀번호 불일치", "err");
  }
  applyPwGate();
}
els.setverApply.addEventListener("click", applySetver);
els.newverEntry.addEventListener("keydown", (e) => { if (e.key === "Enter") applySetver(); });
function applySetver() {
  if (!state.pwVerified) { setverStatus("비밀번호 확인이 필요합니다", "err"); return; }
  const ver = els.newverEntry.value.trim();
  if (!ver) { setverStatus("새 버전을 입력하세요", "err"); return; }
  if (/\s/.test(ver)) { setverStatus("버전에 공백 불가", "err"); return; }
  if (ver.length > 31) { setverStatus("버전이 너무 깁니다 (≤31자)", "err"); return; }
  const pw = els.pwEntry.value.trim();
  setverStatus("요청 전송…", null);
  state.setverPending = true;
  sendCommand(`setver ${pw} ${ver}`);
}

function onVerified() {
  if (state.verified) return;
  state.verified = true;
  if (state.verTimer) { clearTimeout(state.verTimer); state.verTimer = null; }
  setLamp("on");
  setVerified(true);            // 탭 컨트롤 활성화
  rxAppend("[연결 확인] 펌웨어 응답 OK", "info");
  sendCommand("status");        // 현재값 동기화
}

// ── 송신 ────────────────────────────────────────────────────────────
//   opts.silent=true → 로컬 에코 억제(ver 재시도 등에서 사용).
async function sendCommand(cmd, opts = {}) {
  if (!state.writer) {
    if (!opts.silent) rxAppend(`(미연결) ${cmd}`, "info");
    return;
  }
  try {
    const encoder = new TextEncoder();
    await state.writer.write(encoder.encode(cmd + LINE_ENDING));
    if (!opts.silent) rxAppend(">> " + cmd, "tx");
  } catch (e) {
    rxAppend(`[전송 실패] ${e.message}`, "err");
    setLamp("error");
    disconnect();
  }
}

// ── TX 입력 ─────────────────────────────────────────────────────────
els.txSend.addEventListener("click", () => txSend());
els.txInput.addEventListener("keydown", (e) => { if (e.key === "Enter") txSend(); });
function txSend() {
  const v = els.txInput.value.trim();
  if (!v) return;
  sendCommand(v);
  els.txInput.value = "";
}

// ── 탭 전환 ─────────────────────────────────────────────────────────
els.tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ── 색상 행 초기화 ──────────────────────────────────────────────────
buildColorRows();

// ── 이전 승인 포트 자동 복원 ────────────────────────────────────────
(async () => {
  if (!serialApi) return;
  try {
    const ports = await serialApi.getPorts();
    if (ports.length > 0) {
      state.port = ports[0];
      els.portName.textContent = describePort(ports[0]) + " (기억됨)";
      els.connect.disabled = false;
    }
  } catch (_) {}
})();

// ── 페이지 종료 시 정리 ─────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  if (state.port && state.reader) disconnect();
});
