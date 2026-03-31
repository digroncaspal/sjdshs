import { useState, useEffect, useCallback, useRef } from "react";
import {
  collection, addDoc, getDocs, deleteDoc, setDoc,
  doc, getDoc, query, where, orderBy, serverTimestamp,
  onSnapshot, updateDoc, writeBatch,
} from "firebase/firestore";
import { db } from "./services/firebase";

// ── 디자인 토큰 ──────────────────────────────────────
const C = {
  navy:      "#0f1f3d",
  navyMid:   "#162849",
  navyLight: "#1e3a5f",
  navyBorder:"#243b55",
  accent:    "#2563eb",
  accentSoft:"#3b82f6",
  gold:      "#f59e0b",
  red:       "#ef4444",
  green:     "#10b981",
  purple:    "#8b5cf6",
  bg:        "#f5f7fa",
  bgCard:    "#ffffff",
  border:    "#e8edf5",
  text:      "#0f1f3d",
  textSub:   "#64748b",
  textMuted: "#94a3b8",
};

// ── 상수 ──────────────────────────────────────────────
const SCHEDULE_TYPES = ["수행평가", "시험", "행사", "과제", "기타"];
const TYPE_META = {
  수행평가: { color: C.gold,   bg: "#fffbeb", icon: "✏️" },
  시험:     { color: C.red,    bg: "#fef2f2", icon: "📝" },
  행사:     { color: C.purple, bg: "#f5f3ff", icon: "🎉" },
  과제:     { color: C.accent, bg: "#eff6ff", icon: "📚" },
  기타:     { color: "#6b7280",bg: "#f9fafb", icon: "📌" },
};
const MEAL_META = {
  조식: { icon: "🌅", color: C.gold,   bg: "#fffbeb", label: "조식 (아침)" },
  중식: { icon: "☀️", color: C.green,  bg: "#ecfdf5", label: "중식 (점심)" },
  석식: { icon: "🌙", color: C.purple, bg: "#f5f3ff", label: "석식 (저녁)" },
};
const NOTICE_SCOPES = {
  class:  { label: "반 공지",   color: C.accent, bg: "#eff6ff", icon: "🏠" },
  grade:  { label: "학년 공지", color: C.purple, bg: "#f5f3ff", icon: "📚" },
  school: { label: "전교 공지", color: C.red,    bg: "#fef2f2", icon: "📢" },
};
const DAY_KR   = ["일","월","화","수","목","금","토"];
const MONTH_KR = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
const MAX_CLASS = 8;
const ADMIN_CODE = "20266202";
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
const HEARTBEAT_INTERVAL  = 45 * 1000;
const INACTIVE_DAYS = 30;

const storage = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

function getTodayDash() { return new Date().toISOString().slice(0,10); }

function getTargetWeekDates() {
  const today = new Date();
  const dow   = today.getDay();
  const isWknd = dow === 0 || dow === 6;
  const base  = new Date(today);
  if (isWknd) base.setDate(today.getDate() + (dow === 0 ? 1 : 2));
  else base.setDate(today.getDate() - (dow - 1));
  return Array.from({length:5}, (_,i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toISOString().slice(0,10).replace(/-/g,"");
  });
}

function getDday(dateStr) {
  const diff = Math.ceil((new Date(dateStr) - new Date(getTodayDash())) / 86400000);
  if (diff === 0) return { label:"D-Day", color:C.red,       urgent:true };
  if (diff > 0 && diff <= 7) return { label:`D-${diff}`, color:C.gold, urgent:true };
  if (diff > 0) return { label:`D-${diff}`, color:C.textMuted, urgent:false };
  return { label:`D+${Math.abs(diff)}`, color:"#cbd5e1", urgent:false, past:true };
}

function isWeekend(dateStr) {
  const d = new Date(dateStr).getDay();
  return d === 0 || d === 6;
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const ts = lastSeen?.toDate ? lastSeen.toDate() : new Date(lastSeen);
  return Date.now() - ts.getTime() < ONLINE_THRESHOLD_MS;
}

function useBreakpoint() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return { isMobile: w < 640, isTablet: w >= 640 && w < 1024, isDesktop: w >= 1024 };
}

function parseMenu(raw) {
  return raw.replace(/<br\/>/g,"\n").split("\n")
    .map(s => s.replace(/\([\d.,/]+\)/g,"").trim()).filter(Boolean);
}

async function fetchDayMeals(dateStr) {
  try {
    const res  = await fetch(`/api/lunch?date=${dateStr}`);
    const data = await res.json();
    const rows = data?.mealServiceDietInfo?.[1]?.row;
    if (!rows) return {};
    const meals = {};
    rows.forEach(r => { meals[r.MMEAL_SC_NM] = parseMenu(r.DDISH_NM); });
    return meals;
  } catch { return {}; }
}

async function fetchTargetWeekMeals() {
  const dates   = getTargetWeekDates();
  const results = await Promise.all(dates.map(d => fetchDayMeals(d)));
  const map = {};
  dates.forEach((d,i) => {
    const dash = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    if (Object.keys(results[i]).length > 0) map[dash] = results[i];
  });
  return map;
}

async function fetchMonthSchedule(year, month) {
  try {
    const m    = String(month).padStart(2,"0");
    const last = new Date(year, month, 0).getDate();
    const res  = await fetch(`/api/schedule?from=${year}${m}01&to=${year}${m}${String(last).padStart(2,"0")}`);
    const data = await res.json();
    const rows = data?.SchoolSchedule?.[1]?.row;
    if (!rows) return [];
    return rows.map(r => ({
      date:  `${r.AA_YMD.slice(0,4)}-${r.AA_YMD.slice(4,6)}-${r.AA_YMD.slice(6,8)}`,
      title: r.EVENT_NM,
    }));
  } catch { return []; }
}

async function verifyOrCreateClass(grade, cls, code) {
  const classRef = doc(db, "classes", `${grade}-${cls}`);
  const snap     = await getDoc(classRef);
  if (!snap.exists()) {
    await setDoc(classRef, { code, createdAt: serverTimestamp() });
    return { ok: true, isNew: true };
  }
  if (snap.data().code !== code) return { ok: false };
  return { ok: true, isNew: false };
}

async function changeClassCode(grade, cls, newCode) {
  await updateDoc(doc(db, "classes", `${grade}-${cls}`), { code: newCode });
}

async function registerMember(classCode, grade, cls, name, studentId) {
  // 같은 학번의 기존 문서 삭제
  const existing = await getDocs(query(collection(db,"members"), where("studentId","==",studentId)));
  const batch = writeBatch(db);
  existing.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();

  const memberId = `${classCode}_${studentId}`;
  await setDoc(doc(db, "members", memberId), {
    name, grade, cls, classCode, studentId,
    joinedAt:  serverTimestamp(),
    lastSeen:  serverTimestamp(),
    online:    true,
  });
  return memberId;
}

async function heartbeat(memberId) {
  try { await updateDoc(doc(db,"members",memberId), { lastSeen: serverTimestamp(), online: true }); } catch {}
}
async function setOffline(memberId) {
  try { await updateDoc(doc(db,"members",memberId), { online: false }); } catch {}
}
async function kickMember(memberId) { await deleteDoc(doc(db,"members",memberId)); }

async function cleanupInactiveMembers(classCode) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - INACTIVE_DAYS);
    const snap  = await getDocs(query(collection(db,"members"), where("classCode","==",classCode)));
    const batch = writeBatch(db);
    let count = 0;
    snap.docs.forEach(d => {
      const ls = d.data().lastSeen;
      if (!ls) return;
      const ts = ls?.toDate ? ls.toDate() : new Date(ls);
      if (ts < cutoff) { batch.delete(d.ref); count++; }
    });
    if (count > 0) await batch.commit();
  } catch {}
}

// ══════════════════════════════════════════════════════
// CSS - 네이비 모던
// ══════════════════════════════════════════════════════
const GLOBAL_CSS = `
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  html, body { width:100%; height:100%; }
  body { background:${C.bg}; font-family:'Pretendard','Noto Sans KR',sans-serif; overflow:hidden; color:${C.text}; }
  #root { width:100%; height:100%; display:flex; flex-direction:column; }
  input,textarea,select,button { font-family:inherit; }
  input:focus,textarea:focus,select:focus { outline:none; }
  ::placeholder { color:${C.textMuted}; }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-thumb { background:#dde3ef; border-radius:4px; }

  @keyframes fadeUp  { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
  @keyframes popIn   { 0%{opacity:0;transform:scale(.95)} 100%{opacity:1;transform:scale(1)} }
  @keyframes float   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
  @keyframes pulse   { 0%,100%{opacity:.4} 50%{opacity:.8} }
  @keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  @keyframes spin    { to{transform:rotate(360deg)} }
  @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.2} }

  /* 카드 */
  .card {
    background: ${C.bgCard};
    border-radius: 14px;
    border: 1px solid ${C.border};
    box-shadow: 0 1px 8px rgba(15,31,61,.05);
  }
  .card-hover {
    transition: transform .15s, box-shadow .15s;
    cursor: pointer;
  }
  .card-hover:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(15,31,61,.09);
  }

  /* 태그 */
  .tag {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 3px 8px; border-radius: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: .2px;
  }

  /* 인풋 */
  .field {
    width: 100%; padding: 11px 14px;
    background: ${C.bg}; border: 1.5px solid ${C.border};
    border-radius: 10px; font-size: 14px; color: ${C.text};
    transition: border-color .2s, box-shadow .2s;
  }
  .field:focus {
    border-color: ${C.accent};
    box-shadow: 0 0 0 3px rgba(37,99,235,.1);
    background: #fff;
  }

  /* 버튼 */
  .btn {
    padding: 10px 18px; border: none; border-radius: 9px;
    font-size: 13px; font-weight: 700; cursor: pointer;
    transition: all .15s;
  }
  .btn-navy {
    background: ${C.navy}; color: #fff;
    box-shadow: 0 2px 8px rgba(15,31,61,.2);
  }
  .btn-navy:hover { background: ${C.navyLight}; transform: translateY(-1px); }
  .btn-navy:active { transform: scale(.97); }
  .btn-ghost {
    background: ${C.bg}; color: ${C.textSub};
    border: 1px solid ${C.border};
  }
  .btn-ghost:hover { background: #edf0f7; color: ${C.text}; }
  .btn-danger { background: #fef2f2; color: ${C.red}; border: 1px solid #fecaca; }
  .btn-danger:hover { background: ${C.red}; color: #fff; }

  /* 사이드 네비 */
  .nav-item {
    width: 100%; padding: 9px 12px; border-radius: 9px; border: none;
    display: flex; align-items: center; gap: 10px;
    font-size: 13.5px; font-weight: 500; cursor: pointer;
    transition: all .12s; text-align: left; margin-bottom: 2px;
    background: transparent; color: rgba(255,255,255,.6);
  }
  .nav-item:hover { background: rgba(255,255,255,.08); color: rgba(255,255,255,.9); }
  .nav-item.active { background: rgba(255,255,255,.12); color: #fff; font-weight: 700; }

  /* 하단 탭 */
  .tab-btn {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 9px 0 7px; border: none; background: transparent;
    cursor: pointer; transition: all .12s; flex: 1;
    color: ${C.textMuted};
  }
  .tab-btn.active { color: ${C.accent}; }
  .tab-btn:hover { color: ${C.text}; }

  /* 달력 */
  .cal-grid { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); gap: 2px; }
  .cal-cell {
    aspect-ratio: 1/1.05; min-height: 60px;
    padding: 4px; border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer; overflow: hidden;
    transition: background .12s;
  }
  .cal-cell:hover { background: #eef1f8; }
  .cal-cell.today { background: #eff6ff; border-color: ${C.accent}; }
  .cal-cell.selected { background: #eff6ff; border-color: ${C.accent}; }
  .cal-cell.empty { cursor: default; pointer-events: none; }
  .cal-cell.wknd { background: #fafbfd; }
  .cal-cell.wknd:hover { background: #f0f2f8; }

  /* 온라인 점 */
  .dot-on  { width:8px; height:8px; border-radius:50%; background:${C.green}; border:2px solid #fff; animation:blink 2.5s ease-in-out infinite; }
  .dot-off { width:8px; height:8px; border-radius:50%; background:#dde3ef; border:2px solid #fff; }

  /* 로그인 셀렉트 */
  .login-sel {
    width:100%; padding:11px 14px;
    background:rgba(255,255,255,.1); border:1.5px solid rgba(255,255,255,.18);
    border-radius:10px; color:#fff; font-size:14px;
    cursor:pointer; appearance:none; -webkit-appearance:none;
  }
  .login-sel option { background:${C.navyMid}; color:#fff; }

  /* 범위 탭 */
  .scope-pill {
    padding: 6px 13px; border: none; border-radius: 20px;
    font-size: 12px; font-weight: 700; cursor: pointer;
    transition: all .12s;
  }

  /* 페이지 패딩 */
  .pp { padding: 16px; }
  @media(min-width:640px)  { .pp { padding: 20px 24px; } }
  @media(min-width:1024px) { .pp { padding: 24px 32px; } }
`;

// ══════════════════════════════════════════════════════
// 앱 진입점
// ══════════════════════════════════════════════════════
export default function App() {
  const [user,    setUser]    = useState(() => storage.get("sjdshs_user"));
  const [page,    setPage]    = useState("home");
  const [isAdmin, setIsAdmin] = useState(false);
  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {!user
        ? <LoginPage onLogin={(u) => { storage.set("sjdshs_user", u); setUser(u); }} />
        : <MainApp user={user} page={page} setPage={setPage} isAdmin={isAdmin} setIsAdmin={setIsAdmin}
            onLogout={() => { storage.set("sjdshs_user", null); setUser(null); setIsAdmin(false); }} />
      }
    </>
  );
}

// ══════════════════════════════════════════════════════
// 로그인 - 학번(학년반번호) + 이름
// ══════════════════════════════════════════════════════
function LoginPage({ onLogin }) {
  const [name,  setName]  = useState("");
  const [sid,   setSid]   = useState(""); // studentId: 학년(1)+반(2)+번호(2) = 5자리
  const [code,  setCode]  = useState("");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  // 학번 파싱: 10215 → grade=1, cls=02, num=15
  function parseSid(s) {
    if (s.length < 4) return null;
    const grade = s[0];
    const cls   = s.length === 5 ? s.slice(1,3) : s.slice(1,2); // 반 1~2자리
    const num   = s.slice(-2);
    if (!["1","2","3"].includes(grade)) return null;
    const clsNum = parseInt(cls, 10);
    if (clsNum < 1 || clsNum > MAX_CLASS) return null;
    return { grade, cls: String(clsNum), num };
  }

  async function submit() {
    if (!name.trim())       { setErr("이름을 입력해주세요"); return; }
    if (sid.length < 4)     { setErr("학번을 올바르게 입력해주세요 (예: 10215)"); return; }
    if (code.trim().length < 4) { setErr("반 코드는 4자 이상이에요"); return; }

    const parsed = parseSid(sid);
    if (!parsed) { setErr("학번 형식이 올바르지 않아요 (예: 10215)"); return; }

    setBusy(true);
    try {
      const { grade, cls } = parsed;
      const result = await verifyOrCreateClass(grade, cls, code.trim().toUpperCase());
      if (!result.ok) {
        setErr(`${grade}학년 ${cls}반 코드가 틀렸어요. 반 친구에게 코드를 받아요!`);
        setBusy(false);
        return;
      }
      const classCode = code.trim().toUpperCase();
      const memberId  = await registerMember(classCode, grade, cls, name.trim(), sid.trim());
      cleanupInactiveMembers(classCode);
      onLogin({ name:name.trim(), classCode, grade, cls, studentId:sid.trim(), memberId, isNew:result.isNew });
    } catch(e) {
      console.error(e);
      setErr("오류가 발생했어요. 다시 시도해줘요.");
      setBusy(false);
    }
  }

  return (
    <div style={{ width:"100%", minHeight:"100dvh", display:"flex", background:C.navy, position:"relative", overflow:"hidden" }}>
      {/* 배경 장식 */}
      <div style={{ position:"absolute", inset:0, overflow:"hidden", pointerEvents:"none" }}>
        <div style={{ position:"absolute", width:400, height:400, borderRadius:"50%", background:C.accentSoft, opacity:.06, top:"-10%", right:"-5%", filter:"blur(80px)" }} />
        <div style={{ position:"absolute", width:300, height:300, borderRadius:"50%", background:"#818cf8", opacity:.05, bottom:"5%", left:"-5%", filter:"blur(60px)" }} />
        {/* 격자 패턴 */}
        <div style={{ position:"absolute", inset:0, backgroundImage:`linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px)`, backgroundSize:"40px 40px" }} />
      </div>

      {/* 좌측 브랜딩 (데스크탑만) */}
      <div style={{ display:"none", flex:1, flexDirection:"column", justifyContent:"center", padding:"60px 60px", position:"relative" }}
        className="login-left">
        <style>{`.login-left { display: none; } @media(min-width:900px){ .login-left { display: flex !important; } }`}</style>
        <div style={{ fontSize:13, color:"rgba(255,255,255,.4)", letterSpacing:3, fontWeight:700, marginBottom:20 }}>SEJONG DAESUNG HIGH SCHOOL</div>
        <h1 style={{ fontSize:48, fontWeight:900, color:"#fff", letterSpacing:-2, lineHeight:1.1, marginBottom:16 }}>
          세종대성<br/>
          <span style={{ color:C.accentSoft }}>클래스</span>
        </h1>
        <p style={{ fontSize:16, color:"rgba(255,255,255,.45)", lineHeight:1.8 }}>
          우리 반 전용<br/>일정 · 공지 · 급식 · 학사일정
        </p>
      </div>

      {/* 우측 로그인 카드 */}
      <div style={{ width:"100%", maxWidth:480, margin:"auto", padding:24, position:"relative", zIndex:1, display:"flex", flexDirection:"column", justifyContent:"center", minHeight:"100dvh" }}>
        <div style={{ animation:"fadeUp .4s ease" }}>
          {/* 모바일 로고 */}
          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ fontSize:44, marginBottom:10, animation:"float 3s ease-in-out infinite", display:"inline-block" }}>🏫</div>
            <h1 style={{ fontSize:24, fontWeight:900, color:"#fff", letterSpacing:-1 }}>
              세종대성 <span style={{ color:C.accentSoft }}>클래스</span>
            </h1>
            <p style={{ fontSize:12, color:"rgba(255,255,255,.4)", marginTop:5 }}>우리 반 전용 앱</p>
          </div>

          <div style={{ background:"rgba(255,255,255,.06)", backdropFilter:"blur(20px)", border:"1px solid rgba(255,255,255,.1)", borderRadius:18, padding:"28px 24px" }}>

            <div style={{ marginBottom:14 }}>
              <label style={LL}>이름</label>
              <input value={name} placeholder="홍길동"
                onChange={e=>{setName(e.target.value);setErr("");}}
                onKeyDown={e=>e.key==="Enter"&&submit()}
                style={{ width:"100%", padding:"11px 14px", background:"rgba(255,255,255,.08)", border:"1.5px solid rgba(255,255,255,.12)", borderRadius:10, color:"#fff", fontSize:14 }} />
            </div>

            <div style={{ marginBottom:14 }}>
              <label style={LL}>학번</label>
              <input value={sid} placeholder="예: 10215 (1학년 2반 15번)"
                onChange={e=>{setSid(e.target.value.replace(/\D/g,""));setErr("");}}
                onKeyDown={e=>e.key==="Enter"&&submit()}
                maxLength={5}
                style={{ width:"100%", padding:"11px 14px", background:"rgba(255,255,255,.08)", border:"1.5px solid rgba(255,255,255,.12)", borderRadius:10, color:"#fff", fontSize:14, letterSpacing:3, fontWeight:700 }} />
              <p style={{ fontSize:10, color:"rgba(255,255,255,.3)", marginTop:4 }}>학년(1자리) + 반(2자리) + 번호(2자리)</p>
            </div>

            <div style={{ marginBottom:8 }}>
              <label style={LL}>반 코드</label>
              <input value={code} placeholder="4자 이상"
                onChange={e=>{setCode(e.target.value.toUpperCase());setErr("");}}
                onKeyDown={e=>e.key==="Enter"&&submit()}
                style={{ width:"100%", padding:"11px 14px", background:"rgba(255,255,255,.08)", border:"1.5px solid rgba(255,255,255,.12)", borderRadius:10, color:"#fff", fontSize:14, letterSpacing:3, fontWeight:700 }} />
              <p style={{ fontSize:10, color:"rgba(255,255,255,.28)", marginTop:4 }}>💡 처음 입력한 코드가 우리 반 코드가 됩니다</p>
            </div>

            {err && (
              <div style={{ fontSize:12, color:"#fca5a5", background:"rgba(239,68,68,.1)", border:"1px solid rgba(239,68,68,.2)", borderRadius:8, padding:"9px 12px", marginBottom:14, lineHeight:1.5 }}>
                ⚠️ {err}
              </div>
            )}

            <button onClick={submit} disabled={busy}
              style={{ width:"100%", marginTop:6, padding:"13px", border:"none", borderRadius:10, background:C.accent, color:"#fff", fontSize:14, fontWeight:800, cursor:busy?"not-allowed":"pointer", opacity:busy?.7:1, boxShadow:`0 4px 16px rgba(37,99,235,.4)`, transition:"all .15s" }}>
              {busy
                ? <span style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                    <span style={{ width:14, height:14, border:"2px solid rgba(255,255,255,.3)", borderTopColor:"#fff", borderRadius:"50%", animation:"spin .7s linear infinite", display:"inline-block" }} />
                    확인 중...
                  </span>
                : "입장하기 →"
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
const LL = { display:"block", fontSize:11, fontWeight:700, color:"rgba(255,255,255,.5)", letterSpacing:1, marginBottom:6 };

// ══════════════════════════════════════════════════════
// 메인 앱
// ══════════════════════════════════════════════════════
function MainApp({ user, page, setPage, isAdmin, setIsAdmin, onLogout }) {
  const { isMobile, isDesktop } = useBreakpoint();
  const [schedules, setSchedules] = useState([]);
  const [notices,   setNotices]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [toast,     setToast]     = useState(null);
  const hbRef = useRef(null);

  const showToast = useCallback((msg, type="info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => {
    if (!user.memberId) return;
    heartbeat(user.memberId);
    hbRef.current = setInterval(() => heartbeat(user.memberId), HEARTBEAT_INTERVAL);
    const handleUnload = () => setOffline(user.memberId);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      clearInterval(hbRef.current);
      window.removeEventListener("beforeunload", handleUnload);
      setOffline(user.memberId);
    };
  }, [user.memberId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const ss = await getDocs(query(collection(db,"schedules"), where("classCode","==",user.classCode), orderBy("date","asc")));
        setSchedules(ss.docs.map(d => ({ id:d.id, ...d.data() })));
        await loadNotices();
      } catch(e) { console.error(e); showToast("❌ 데이터 로드 실패","error"); }
      setLoading(false);
    })();
  }, [user.classCode]);

  async function loadNotices() {
    try {
      const [cs, gs, ss] = await Promise.all([
        getDocs(query(collection(db,"notices"), where("scope","==","class"),  where("classCode","==",user.classCode), orderBy("createdAt","desc"))),
        getDocs(query(collection(db,"notices"), where("scope","==","grade"),  where("grade","==",user.grade),         orderBy("createdAt","desc"))),
        getDocs(query(collection(db,"notices"), where("scope","==","school"),                                         orderBy("createdAt","desc"))),
      ]);
      const all = [...cs.docs, ...gs.docs, ...ss.docs]
        .map(d => ({ id:d.id, ...d.data() }))
        .sort((a,b) => {
          const ta = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt||0);
          const tb = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt||0);
          return tb - ta;
        });
      setNotices(all);
    } catch(e) { console.error(e); }
  }

  const todayStr = getTodayDash();
  const upcoming = schedules.filter(s => s.date >= todayStr && !isWeekend(s.date)).sort((a,b) => a.date.localeCompare(b.date));
  const todaySch = schedules.filter(s => s.date === todayStr);

  const NAV = [
    { id:"home",     icon:"🏠", label:"홈" },
    { id:"schedule", icon:"📅", label:"일정" },
    { id:"academic", icon:"🗓", label:"학사" },
    { id:"notice",   icon:"📢", label:"공지" },
    { id:"lunch",    icon:"🍱", label:"급식" },
    { id:"members",  icon:"👥", label:"인원" },
  ];

  const pages = {
    home:     <HomePage     user={user} schedules={schedules} notices={notices} upcoming={upcoming} todaySch={todaySch} setPage={setPage} />,
    schedule: <SchedulePage user={user} schedules={schedules} setSchedules={setSchedules} showToast={showToast} />,
    academic: <AcademicPage />,
    notice:   <NoticePage   user={user} notices={notices} loadNotices={loadNotices} showToast={showToast} isAdmin={isAdmin} />,
    lunch:    <LunchPage />,
    members:  <MembersPage  user={user} showToast={showToast} onLogout={onLogout} isAdmin={isAdmin} setIsAdmin={setIsAdmin} />,
  };

  const pageTitle = { home:"홈", schedule:"일정 관리", academic:"학사일정", notice:"공지", lunch:"급식", members:"반 인원" };

  return (
    <div style={{ width:"100%", height:"100vh", display:"flex", background:C.bg, overflow:"hidden" }}>
      {toast && (
        <div style={{ position:"fixed", bottom: !isDesktop?72:20, left:"50%", transform:"translateX(-50%)", background: toast.type==="error"?"#ef4444":C.navy, color:"#fff", padding:"10px 20px", borderRadius:30, fontSize:13, fontWeight:600, zIndex:9999, whiteSpace:"nowrap", boxShadow:`0 8px 24px rgba(15,31,61,.25)`, animation:"toastIn .25s ease" }}>
          {toast.msg}
        </div>
      )}

      {/* ── 사이드바 (데스크탑) ── */}
      {isDesktop && (
        <aside style={{ width:220, height:"100vh", background:C.navy, display:"flex", flexDirection:"column", flexShrink:0, overflow:"hidden" }}>
          {/* 로고 */}
          <div style={{ padding:"24px 16px 20px", borderBottom:"1px solid rgba(255,255,255,.07)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:36, height:36, borderRadius:9, background:"rgba(255,255,255,.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🏫</div>
              <div>
                <div style={{ fontSize:13, fontWeight:800, color:"#fff", letterSpacing:-.3 }}>세종대성</div>
                <div style={{ fontSize:11, color:"rgba(255,255,255,.35)", letterSpacing:.5 }}>클래스</div>
              </div>
            </div>
          </div>

          {/* 반 정보 */}
          <div style={{ padding:"12px 16px", borderBottom:"1px solid rgba(255,255,255,.07)" }}>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.35)", letterSpacing:1.5, fontWeight:700, marginBottom:3 }}>MY CLASS</div>
            <div style={{ fontSize:13, color:"rgba(255,255,255,.8)", fontWeight:600 }}>{user.grade}학년 {user.cls}반</div>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.35)", marginTop:1 }}>{user.classCode}{isAdmin?" · 👑 관리자":""}</div>
          </div>

          {/* 네비 */}
          <nav style={{ flex:1, padding:"10px 10px", overflowY:"auto" }}>
            {NAV.map(n => (
              <button key={n.id} className={`nav-item${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:16 }}>{n.icon}</span>
                <span>{n.label}</span>
              </button>
            ))}
          </nav>

          {/* 유저 */}
          <div style={{ padding:"14px 16px", borderTop:"1px solid rgba(255,255,255,.07)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:10 }}>
              <div style={{ position:"relative", flexShrink:0 }}>
                <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(255,255,255,.15)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize:13 }}>{user.name[0]}</div>
                <div className="dot-on" style={{ position:"absolute", bottom:0, right:0 }} />
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{user.name}</div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,.4)" }}>{user.studentId}</div>
              </div>
            </div>
            <button onClick={onLogout} style={{ width:"100%", padding:"7px", borderRadius:7, border:"1px solid rgba(255,255,255,.1)", background:"rgba(255,255,255,.06)", color:"rgba(255,255,255,.5)", fontSize:11, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(239,68,68,.2)";e.currentTarget.style.color="#fca5a5";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,.06)";e.currentTarget.style.color="rgba(255,255,255,.5)";}}>
              로그아웃
            </button>
          </div>
        </aside>
      )}

      {/* ── 콘텐츠 ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>

        {/* 헤더 */}
        {isDesktop ? (
          <header style={{ background:C.bgCard, borderBottom:`1px solid ${C.border}`, padding:"0 28px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
            <div>
              <span style={{ fontSize:15, fontWeight:800, color:C.text }}>{pageTitle[page]}</span>
              <span style={{ fontSize:12, color:C.textMuted, marginLeft:10 }}>
                {new Date().toLocaleDateString("ko-KR",{ month:"long", day:"numeric", weekday:"short" })}
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ position:"relative" }}>
                <div style={{ width:30, height:30, borderRadius:"50%", background:C.navy, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize:12 }}>{user.name[0]}</div>
                <div className="dot-on" style={{ position:"absolute", bottom:0, right:0 }} />
              </div>
              <span style={{ fontSize:13, fontWeight:600, color:C.text }}>{user.name}</span>
            </div>
          </header>
        ) : (
          <header style={{ background:C.navy, padding:"10px 18px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, boxShadow:"0 2px 12px rgba(15,31,61,.2)" }}>
            <div>
              <div style={{ fontSize:10, color:"rgba(255,255,255,.45)", letterSpacing:1.5, fontWeight:700 }}>{user.grade}학년 {user.cls}반 · {user.classCode}</div>
              <div style={{ fontSize:14, fontWeight:800, color:"#fff" }}>{user.name} 님</div>
            </div>
            <button onClick={onLogout} style={{ background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.1)", padding:"5px 11px", borderRadius:16, color:"rgba(255,255,255,.7)", fontSize:11, fontWeight:600, cursor:"pointer" }}>나가기</button>
          </header>
        )}

        {/* 페이지 */}
        <main style={{ flex:1, overflowY:"auto", paddingBottom: !isDesktop?66:0 }} className="pp">
          {loading
            ? <div style={{ textAlign:"center", padding:"60px 20px" }}>
                <div style={{ fontSize:36, animation:"float 1.5s ease-in-out infinite" }}>⏳</div>
                <div style={{ fontSize:13, color:C.textMuted, marginTop:12, fontWeight:600 }}>불러오는 중...</div>
              </div>
            : <div key={page} style={{ animation:"slideUp .25s ease" }}>{pages[page]}</div>
          }
        </main>

        {/* 하단 탭 (모바일/태블릿) */}
        {!isDesktop && (
          <nav style={{ position:"fixed", bottom:0, left:0, right:0, background:C.bgCard, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:100, boxShadow:"0 -1px 12px rgba(15,31,61,.06)" }}>
            {NAV.map(n => (
              <button key={n.id} className={`tab-btn${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:20, lineHeight:1 }}>{n.icon}</span>
                <span style={{ fontSize: isMobile?8.5:10, fontWeight: page===n.id?700:500 }}>{n.label}</span>
                {page===n.id && (
                  <div style={{ width:20, height:2, borderRadius:2, background:C.accent, marginTop:1 }} />
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 홈
// ══════════════════════════════════════════════════════
function HomePage({ user, schedules, notices, upcoming, todaySch, setPage }) {
  const { isDesktop } = useBreakpoint();
  const now      = new Date();
  const dayNames = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const urgent   = upcoming.filter(s => getDday(s.date).urgent).slice(0,4);

  return (
    <div style={{ maxWidth:960, margin:"0 auto" }}>

      {/* 오늘 헤더 카드 */}
      <div style={{ background:C.navy, borderRadius:16, padding: isDesktop?"24px 28px":"18px 20px", marginBottom:18, color:"#fff", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-40, top:-40, width:200, height:200, borderRadius:"50%", background:"rgba(255,255,255,.04)" }} />
        <div style={{ position:"absolute", right:60, bottom:-60, width:160, height:160, borderRadius:"50%", background:"rgba(255,255,255,.03)" }} />
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", fontWeight:700, letterSpacing:2, marginBottom:4 }}>TODAY</div>
          <div style={{ fontSize: isDesktop?22:18, fontWeight:900, letterSpacing:-.5, marginBottom: todaySch.length?12:0 }}>
            {now.getMonth()+1}월 {now.getDate()}일 {dayNames[now.getDay()]}
          </div>
          {todaySch.length > 0
            ? todaySch.map(s => {
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.1)", borderRadius:9, padding:"8px 12px", display:"flex", alignItems:"center", gap:8, marginTop:6 }}>
                  <span style={{ fontSize:14 }}>{meta.icon}</span>
                  <span style={{ fontSize:13, fontWeight:600, flex:1 }}>{s.title}</span>
                  <span style={{ fontSize:11, color:"rgba(255,255,255,.5)", fontWeight:600 }}>{s.type}</span>
                </div>
              );
            })
            : <div style={{ fontSize:12, color:"rgba(255,255,255,.4)", marginTop:4 }}>오늘 등록된 일정이 없어요</div>
          }
        </div>
      </div>

      {/* 2열 그리드 */}
      <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:14 }}>

        {/* 다가오는 일정 */}
        <div className="card" style={{ padding:18 }}>
          <SH title="다가오는 일정" onMore={() => setPage("schedule")} />
          {upcoming.length === 0
            ? <Muted>다가오는 평일 일정이 없어요</Muted>
            : upcoming.slice(0,5).map(s => {
              const dd   = getDday(s.date);
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid ${C.border}` }}>
                  <div style={{ width:32, height:32, borderRadius:8, background:meta.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, flexShrink:0 }}>{meta.icon}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.title}</div>
                    <div style={{ fontSize:11, color:C.textMuted, marginTop:1 }}>{s.date.slice(5).replace("-","/")} · {s.authorName}</div>
                  </div>
                  <span style={{ fontSize:12, fontWeight:800, color:dd.color, flexShrink:0 }}>{dd.label}</span>
                </div>
              );
            })
          }
        </div>

        {/* 최근 공지 */}
        <div className="card" style={{ padding:18 }}>
          <SH title="최근 공지" onMore={() => setPage("notice")} />
          {notices.length === 0
            ? <Muted>공지가 없어요</Muted>
            : notices.slice(0,4).map(n => {
              const scope = NOTICE_SCOPES[n.scope] || NOTICE_SCOPES.class;
              return (
                <div key={n.id} style={{ padding:"9px 0", borderBottom:`1px solid ${C.border}` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                    <span className="tag" style={{ background:scope.bg, color:scope.color }}>{scope.icon} {scope.label}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{n.title}</div>
                  <div style={{ fontSize:10, color:C.textMuted, marginTop:2 }}>{n.authorName}</div>
                </div>
              );
            })
          }
        </div>

        {/* D-Day 임박 카드 */}
        {urgent.map((s,i) => {
          const dd   = getDday(s.date);
          const meta = TYPE_META[s.type] || TYPE_META["기타"];
          return (
            <div key={s.id} className="card card-hover" onClick={() => setPage("schedule")} style={{ padding:18, borderLeft:`3px solid ${meta.color}`, animation:`popIn .3s ease ${i*.07}s both` }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                <span className="tag" style={{ background:meta.bg, color:meta.color }}>{meta.icon} {s.type}</span>
                <span style={{ fontSize:22, fontWeight:900, color:dd.color, letterSpacing:-1 }}>{dd.label}</span>
              </div>
              <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{s.title}</div>
              <div style={{ fontSize:11, color:C.textMuted, marginTop:3 }}>{s.date.replace(/-/g,".")}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 일정
// ══════════════════════════════════════════════════════
function SchedulePage({ user, schedules, setSchedules, showToast }) {
  const { isMobile, isDesktop } = useBreakpoint();
  const [showForm,    setShowForm]    = useState(false);
  const [hideWeekend, setHideWeekend] = useState(true);
  const [form,   setForm]   = useState({ title:"", date:"", type:"수행평가" });
  const [saving, setSaving] = useState(false);
  const todayStr = getTodayDash();

  const allUp  = schedules.filter(s => s.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date));
  const allPast = schedules.filter(s => s.date < todayStr).sort((a,b) => b.date.localeCompare(a.date));
  const upcoming = hideWeekend ? allUp.filter(s => !isWeekend(s.date)) : allUp;
  const past     = hideWeekend ? allPast.filter(s => !isWeekend(s.date)) : allPast;

  async function add() {
    if (!form.title.trim()) { showToast("⚠️ 제목을 입력해주세요","error"); return; }
    if (!form.date)          { showToast("⚠️ 날짜를 선택해주세요","error"); return; }
    setSaving(true);
    try {
      const item = { ...form, classCode:user.classCode, authorName:user.name, createdAt:serverTimestamp() };
      const ref  = await addDoc(collection(db,"schedules"), item);
      setSchedules(p => [...p, { id:ref.id, ...item, createdAt:Date.now() }].sort((a,b) => a.date.localeCompare(b.date)));
      setForm({ title:"", date:"", type:"수행평가" });
      setShowForm(false);
      showToast("✅ 일정 추가됨!");
    } catch { showToast("❌ 추가 실패","error"); }
    setSaving(false);
  }

  async function del(id) {
    try { await deleteDoc(doc(db,"schedules",id)); setSchedules(p => p.filter(s => s.id!==id)); showToast("🗑 삭제됐어요"); }
    catch { showToast("❌ 삭제 실패","error"); }
  }

  return (
    <div style={{ maxWidth:820, margin:"0 auto" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18, flexWrap:"wrap", gap:8 }}>
        <PH title="일정 관리" sub="수행평가·시험·행사를 등록해요" />
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn btn-ghost" onClick={() => setHideWeekend(!hideWeekend)} style={{ fontSize:12 }}>
            {hideWeekend ? "주말 제외 ✓" : "주말 포함"}
          </button>
          <button className="btn btn-navy" onClick={() => setShowForm(!showForm)}>
            {showForm ? "✕ 닫기" : "+ 추가"}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="card" style={{ padding:20, marginBottom:18, animation:"popIn .2s ease", borderTop:`3px solid ${C.accent}` }}>
          <div style={{ display:"grid", gridTemplateColumns: isMobile?"1fr":"2fr 1fr 1fr", gap:10, marginBottom:12 }}>
            <div>
              <label style={LBL}>제목</label>
              <input className="field" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="예: 영어 수행평가" />
            </div>
            <div>
              <label style={LBL}>날짜</label>
              <input className="field" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})} />
            </div>
            <div>
              <label style={LBL}>유형</label>
              <select className="field" value={form.type} onChange={e=>setForm({...form,type:e.target.value})} style={{ background:C.bg }}>
                {SCHEDULE_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <button className="btn btn-navy" onClick={add} disabled={saving} style={{ width:"100%" }}>
            {saving?"저장 중...":"일정 추가하기"}
          </button>
        </div>
      )}

      {upcoming.length > 0 && (
        <section style={{ marginBottom:22 }}>
          <GL>다가오는 일정 ({upcoming.length})</GL>
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:10 }}>
            {upcoming.map(s => <SchedCard key={s.id} s={s} user={user} onDel={del} />)}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <GL faded>지난 일정</GL>
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:8, opacity:.5 }}>
            {past.slice(0,6).map(s => <SchedCard key={s.id} s={s} user={user} onDel={del} past />)}
          </div>
        </section>
      )}
      {schedules.length === 0 && <EF icon="📅" text="아직 일정이 없어요" sub="위 버튼으로 첫 일정을 추가해보세요!" />}
    </div>
  );
}

function SchedCard({ s, user, onDel, past }) {
  const dd   = getDday(s.date);
  const meta = TYPE_META[s.type] || TYPE_META["기타"];
  return (
    <div className="card" style={{ padding:14, borderLeft:`3px solid ${dd.urgent&&!past?meta.color:C.border}` }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:7 }}>
        <span className="tag" style={{ background:meta.bg, color:meta.color }}>{meta.icon} {s.type}</span>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {!past && <span style={{ fontSize:12, fontWeight:800, color:dd.color }}>{dd.label}</span>}
          {s.authorName === user.name && (
            <button onClick={()=>onDel(s.id)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:13, cursor:"pointer", lineHeight:1, transition:"color .15s" }}
              onMouseEnter={e=>e.target.style.color=C.red} onMouseLeave={e=>e.target.style.color=C.textMuted}>✕</button>
          )}
        </div>
      </div>
      <div style={{ fontSize:14, fontWeight:800, color:C.text, marginBottom:2 }}>{s.title}</div>
      <div style={{ fontSize:11, color:C.textMuted }}>{s.date.slice(5).replace("-","/")} · {DAY_KR[new Date(s.date).getDay()]} · {s.authorName}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 학사일정
// ══════════════════════════════════════════════════════
function AcademicPage() {
  const { isMobile, isDesktop } = useBreakpoint();
  const today   = new Date();
  const [year,  setYear]    = useState(today.getFullYear());
  const [month, setMonth]   = useState(today.getMonth() + 1);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setSelected(null);
    (async () => { setLoading(true); setEvents(await fetchMonthSchedule(year, month)); setLoading(false); })();
  }, [year, month]);

  function prev() { if (month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1); }
  function next() { if (month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1); }

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay    = new Date(year, month-1, 1).getDay();
  const cells = [...Array(firstDay).fill(null), ...Array.from({length:daysInMonth},(_,i)=>i+1)];
  while (cells.length < 42) cells.push(null);
  const todayDash = getTodayDash();

  function evForDay(day) {
    if (!day) return [];
    return events.filter(e => e.date === `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`);
  }
  const selEvs = selected ? evForDay(selected) : [];

  return (
    <div style={{ maxWidth:960, margin:"0 auto" }}>
      <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 250px":"1fr", gap:16 }}>
        <div className="card" style={{ padding:18 }}>
          {/* 월 헤더 */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
            <button className="btn btn-ghost" onClick={prev} style={{ padding:"6px 12px" }}>‹</button>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:15, fontWeight:800, color:C.text }}>{year}년 {MONTH_KR[month-1]}</div>
              {loading && <div style={{ fontSize:10, color:C.textMuted }}>불러오는 중...</div>}
            </div>
            <button className="btn btn-ghost" onClick={next} style={{ padding:"6px 12px" }}>›</button>
          </div>

          {/* 요일 */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(7,minmax(0,1fr))", marginBottom:4 }}>
            {DAY_KR.map((d,i) => (
              <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:700, padding:"3px 0", color: i===0?C.red:i===6?C.accent:C.textMuted }}>{d}</div>
            ))}
          </div>

          {/* 날짜 */}
          <div className="cal-grid">
            {cells.map((day, idx) => {
              const col  = idx % 7;
              const isSun = col === 0, isSat = col === 6, isWk = isSun||isSat;
              if (!day) return <div key={idx} className="cal-cell empty" />;
              const dash  = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
              const evs   = evForDay(day);
              const isT   = dash === todayDash;
              const isSel = selected === day;
              return (
                <div key={idx} className={`cal-cell${isWk?" wknd":""}${isT?" today":""}${isSel?" selected":""}`}
                  onClick={() => setSelected(isSel?null:day)}>
                  <div style={{ fontSize:11, fontWeight:isT?800:400, textAlign:"right", marginBottom:2, color: isT?C.accent:isSun?C.red:isSat?C.accent:C.textSub }}>{day}</div>
                  {evs.slice(0,isMobile?1:2).map((e,i) => (
                    <div key={i} style={{ fontSize:8, padding:"1px 3px", borderRadius:3, marginBottom:1, background:isWk?"#ede9fe":C.accent+"18", color:isWk?C.purple:C.accent, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontWeight:700 }}>
                      {e.title}
                    </div>
                  ))}
                  {evs.length > (isMobile?1:2) && <div style={{ fontSize:8, color:C.textMuted, textAlign:"right" }}>+{evs.length-(isMobile?1:2)}</div>}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {selected && (
            <div className="card" style={{ padding:16, animation:"popIn .2s ease", borderTop:`3px solid ${C.accent}` }}>
              <div style={{ fontSize:13, fontWeight:800, color:C.accent, marginBottom:8 }}>
                {month}월 {selected}일 ({DAY_KR[new Date(year,month-1,selected).getDay()]})
              </div>
              {selEvs.length === 0
                ? <Muted>학사일정 없음</Muted>
                : selEvs.map((e,i) => (
                  <div key={i} style={{ padding:"7px 10px", borderRadius:8, background:"#eff6ff", marginBottom:5, fontSize:13, fontWeight:600, color:C.text }}>{e.title}</div>
                ))
              }
            </div>
          )}
          <div className="card" style={{ padding:16, flex:1, overflowY:"auto", maxHeight: isDesktop?460:260 }}>
            <div style={{ fontSize:13, fontWeight:800, color:C.text, marginBottom:10 }}>{MONTH_KR[month-1]} 학사일정</div>
            {loading ? <Muted>불러오는 중...</Muted>
              : events.length === 0 ? <Muted>이달 학사일정 없음</Muted>
              : events.map((e,i) => {
                const d  = new Date(e.date);
                const dd = getDday(e.date);
                return (
                  <div key={i} onClick={() => setSelected(d.getDate())}
                    style={{ display:"flex", alignItems:"center", gap:9, padding:"7px 5px", borderRadius:7, marginBottom:2, cursor:"pointer", background: selected===d.getDate()?"#eff6ff":"transparent", transition:"background .12s" }}>
                    <div style={{ minWidth:26, textAlign:"center", flexShrink:0 }}>
                      <div style={{ fontSize:14, fontWeight:900, color: d.getDay()===0?C.red:d.getDay()===6?C.accent:C.navy, lineHeight:1 }}>{d.getDate()}</div>
                      <div style={{ fontSize:9, color:C.textMuted, fontWeight:600 }}>{DAY_KR[d.getDay()]}</div>
                    </div>
                    <div style={{ flex:1, fontSize:12, fontWeight:600, color:C.text, lineHeight:1.4 }}>{e.title}</div>
                    {!dd.past && <span style={{ fontSize:10, fontWeight:800, color:dd.color, flexShrink:0 }}>{dd.label}</span>}
                  </div>
                );
              })
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공지
// ══════════════════════════════════════════════════════
function NoticePage({ user, notices, loadNotices, showToast, isAdmin }) {
  const { isDesktop } = useBreakpoint();
  const [showForm, setShowForm] = useState(false);
  const [selScope, setSelScope] = useState("all");
  const [form,     setForm]     = useState({ title:"", content:"", scope:"class" });
  const [saving,   setSaving]   = useState(false);

  async function add() {
    if (!form.title.trim())   { showToast("⚠️ 제목을 입력해주세요","error"); return; }
    if (!form.content.trim()) { showToast("⚠️ 내용을 입력해주세요","error"); return; }
    setSaving(true);
    try {
      await addDoc(collection(db,"notices"), {
        title:form.title, content:form.content, scope:form.scope,
        classCode:user.classCode, grade:user.grade,
        authorName:user.name, createdAt:serverTimestamp(),
      });
      await loadNotices();
      setForm({ title:"", content:"", scope:"class" });
      setShowForm(false);
      showToast("✅ 공지 등록됨!");
    } catch { showToast("❌ 등록 실패","error"); }
    setSaving(false);
  }

  async function del(id) {
    try { await deleteDoc(doc(db,"notices",id)); await loadNotices(); showToast("🗑 삭제됐어요"); }
    catch { showToast("❌ 삭제 실패","error"); }
  }

  function fmtDate(val) {
    if (!val) return "";
    try { return (val.toDate?val.toDate():new Date(val)).toLocaleDateString("ko-KR",{month:"short",day:"numeric"}); } catch { return ""; }
  }

  const filtered = selScope==="all" ? notices : notices.filter(n => n.scope===selScope);

  return (
    <div style={{ maxWidth:820, margin:"0 auto" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:8 }}>
        <PH title="공지" sub={isAdmin?"반·학년·전교 공지를 올릴 수 있어요":"공지 작성은 관리자만 가능해요"} />
        {isAdmin && (
          <button className="btn btn-navy" onClick={() => setShowForm(!showForm)}>
            {showForm?"✕ 닫기":"+ 공지 작성"}
          </button>
        )}
      </div>

      {isAdmin && showForm && (
        <div className="card" style={{ padding:20, marginBottom:18, animation:"popIn .2s ease", borderTop:`3px solid ${C.accent}` }}>
          <div style={{ marginBottom:14 }}>
            <label style={LBL}>공지 범위</label>
            <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
              {Object.entries(NOTICE_SCOPES).map(([key, s]) => (
                <button key={key} className="scope-pill" onClick={() => setForm(f=>({...f,scope:key}))}
                  style={{ background: form.scope===key?s.color:"#f1f5f9", color: form.scope===key?"#fff":C.textSub }}>
                  {s.icon} {s.label}
                </button>
              ))}
            </div>
            <p style={{ fontSize:11, color:C.textMuted, marginTop:6 }}>
              {form.scope==="class"  && `→ ${user.grade}학년 ${user.cls}반만 볼 수 있어요`}
              {form.scope==="grade"  && `→ ${user.grade}학년 전체가 볼 수 있어요`}
              {form.scope==="school" && "→ 전교생이 볼 수 있어요"}
            </p>
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={LBL}>제목</label>
            <input className="field" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="공지 제목" />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={LBL}>내용</label>
            <textarea className="field" value={form.content} onChange={e=>setForm(f=>({...f,content:e.target.value}))} rows={4} style={{ resize:"none", lineHeight:1.7 }} placeholder="공지 내용" />
          </div>
          <button className="btn btn-navy" onClick={add} disabled={saving} style={{ width:"100%" }}>
            {saving?"등록 중...":"공지 올리기"}
          </button>
        </div>
      )}

      {/* 필터 */}
      <div style={{ display:"flex", gap:7, marginBottom:16, flexWrap:"wrap" }}>
        <button className="scope-pill" onClick={() => setSelScope("all")}
          style={{ background: selScope==="all"?C.navy:"#f1f5f9", color: selScope==="all"?"#fff":C.textSub }}>전체</button>
        {Object.entries(NOTICE_SCOPES).map(([key, s]) => (
          <button key={key} className="scope-pill" onClick={() => setSelScope(key)}
            style={{ background: selScope===key?s.color:"#f1f5f9", color: selScope===key?"#fff":C.textSub }}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {filtered.length === 0
        ? <EF icon="📢" text="공지가 없어요" sub={isAdmin?"위 버튼으로 공지를 작성해보세요!":"관리자가 공지를 올리면 여기 표시돼요"} />
        : (
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:12 }}>
            {filtered.map(n => {
              const scope = NOTICE_SCOPES[n.scope] || NOTICE_SCOPES.class;
              return (
                <div key={n.id} className="card" style={{ padding:18, borderLeft:`3px solid ${scope.color}` }}>
                  <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
                    <div style={{ flex:1 }}>
                      <span className="tag" style={{ background:scope.bg, color:scope.color, marginBottom:6, display:"inline-flex" }}>{scope.icon} {scope.label}</span>
                      <div style={{ fontSize:14, fontWeight:800, color:C.text, lineHeight:1.4 }}>{n.title}</div>
                    </div>
                    {isAdmin && (
                      <button onClick={()=>del(n.id)} style={{ background:"none", border:"none", color:C.textMuted, fontSize:14, cursor:"pointer", marginLeft:8, lineHeight:1, flexShrink:0, transition:"color .15s" }}
                        onMouseEnter={e=>e.target.style.color=C.red} onMouseLeave={e=>e.target.style.color=C.textMuted}>✕</button>
                    )}
                  </div>
                  <div style={{ fontSize:13, color:C.textSub, lineHeight:1.75, marginBottom:10 }}>{n.content}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <div style={{ width:20, height:20, borderRadius:"50%", background:scope.color, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:9, fontWeight:900 }}>{n.authorName[0]}</div>
                    <span style={{ fontSize:11, color:C.textMuted }}>{n.authorName}</span>
                    <span style={{ fontSize:11, color:C.textMuted, marginLeft:"auto" }}>{fmtDate(n.createdAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 급식
// ══════════════════════════════════════════════════════
function LunchPage() {
  const { isMobile, isDesktop } = useBreakpoint();
  const [mealMap, setMealMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [selMeal, setSelMeal] = useState("중식");
  const todayDash = getTodayDash();
  const dow       = new Date().getDay();
  const isWknd    = dow === 0 || dow === 6;

  useEffect(() => {
    (async () => { setLoading(true); setMealMap(await fetchTargetWeekMeals()); setLoading(false); })();
  }, []);

  const todayMeals = mealMap[todayDash] || {};
  const menuDays   = Object.entries(mealMap).sort(([a],[b]) => a.localeCompare(b));
  const mealTypes  = ["조식","중식","석식"];

  if (loading) return <div style={{ textAlign:"center", padding:"60px 0" }}><div style={{ fontSize:34, animation:"float 1.5s ease-in-out infinite" }}>🍱</div><Muted style={{ marginTop:10 }}>급식 정보 불러오는 중...</Muted></div>;

  return (
    <div style={{ maxWidth:820, margin:"0 auto" }}>
      <PH title="급식 메뉴" sub={isWknd?"주말이라 다음 주 급식을 보여드려요":"세종대성고등학교 이번 주 급식"} />

      {!isWknd && Object.keys(todayMeals).length > 0 && (
        <div style={{ marginBottom:18 }}>
          <GL>오늘의 급식</GL>
          <div style={{ display:"grid", gridTemplateColumns: isMobile?"1fr":"repeat(3,1fr)", gap:10 }}>
            {mealTypes.map(type => {
              const meta  = MEAL_META[type];
              const items = todayMeals[type];
              if (!items) return null;
              return (
                <div key={type} style={{ background:C.navy, borderRadius:12, padding:"16px", color:"#fff" }}>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,.45)", fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>{meta.icon} {meta.label.toUpperCase()}</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {items.map((item,i) => <span key={i} style={{ background:"rgba(255,255,255,.1)", padding:"3px 8px", borderRadius:6, fontSize:11, fontWeight:600 }}>{item}</span>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 식사 탭 */}
      <div style={{ display:"flex", gap:7, marginBottom:14 }}>
        {mealTypes.map(type => {
          const meta = MEAL_META[type];
          return (
            <button key={type} className="scope-pill" onClick={() => setSelMeal(type)}
              style={{ background: selMeal===type?meta.color:C.bg, color: selMeal===type?"#fff":C.textSub, border: selMeal===type?"none":`1px solid ${C.border}` }}>
              {meta.icon} {type}
            </button>
          );
        })}
      </div>

      {menuDays.length === 0
        ? <EF icon="🍱" text="급식 정보가 없어요" />
        : (
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:10 }}>
            {menuDays.map(([date, meals]) => {
              const d       = new Date(date);
              const isToday = date === todayDash;
              const items   = meals[selMeal];
              const meta    = MEAL_META[selMeal];
              return (
                <div key={date} className="card" style={{ padding:14, borderLeft:`3px solid ${isToday?meta.color:C.border}` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:9 }}>
                    <span className="tag" style={{ background: isToday?meta.bg:C.bg, color: isToday?meta.color:C.textSub }}>
                      {date.slice(5).replace("-","/")} ({DAY_KR[d.getDay()]})
                    </span>
                    {isToday && <span style={{ fontSize:11, color:meta.color, fontWeight:700 }}>오늘</span>}
                  </div>
                  {items
                    ? <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                        {items.map((item,i) => <span key={i} style={{ fontSize:11, padding:"3px 8px", borderRadius:6, background:C.bg, color:C.textSub, fontWeight:500, border:`1px solid ${C.border}` }}>{item}</span>)}
                      </div>
                    : <Muted>정보 없음</Muted>
                  }
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 반 인원
// ══════════════════════════════════════════════════════
function MembersPage({ user, showToast, onLogout, isAdmin, setIsAdmin }) {
  const { isDesktop } = useBreakpoint();
  const [members,    setMembers]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [adminInput, setAdminInput] = useState("");
  const [showAdmin,  setShowAdmin]  = useState(false);
  const [newCode,    setNewCode]    = useState("");
  const [confirmK,   setConfirmK]   = useState(null);

  useEffect(() => {
    const q     = query(collection(db,"members"), where("classCode","==",user.classCode));
    const unsub = onSnapshot(q, snap => {
      setMembers(snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b) => a.name.localeCompare(b.name,"ko")));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [user.classCode]);

  function tryAdmin() {
    if (adminInput === ADMIN_CODE) { setIsAdmin(true); setShowAdmin(false); showToast("🔑 관리자 권한 활성화!"); }
    else showToast("❌ 관리자 코드가 틀렸어요","error");
    setAdminInput("");
  }

  async function handleChangeCode() {
    if (newCode.trim().length < 4) { showToast("⚠️ 4자 이상 입력해주세요","error"); return; }
    try { await changeClassCode(user.grade, user.cls, newCode.trim().toUpperCase()); showToast("✅ 반 코드 변경됨!"); setNewCode(""); }
    catch { showToast("❌ 변경 실패","error"); }
  }

  async function handleKick(m) {
    try {
      await kickMember(m.id);
      showToast(`🚫 ${m.name}님 강퇴`);
      setConfirmK(null);
      if (m.name === user.name) { storage.set("sjdshs_user", null); onLogout(); }
    } catch { showToast("❌ 강퇴 실패","error"); }
  }

  const online  = members.filter(m => isOnline(m.lastSeen));
  const offline = members.filter(m => !isOnline(m.lastSeen));

  const AVATARS = [
    `${C.navy}`, "#1e40af", "#1d4ed8", "#0369a1", "#065f46", "#7c2d12",
  ];

  function MCard({ m, i }) {
    const on  = isOnline(m.lastSeen);
    const isMe = m.name === user.name;
    return (
      <div className="card" style={{ padding:14, textAlign:"center", position:"relative", opacity: on?1:.65 }}>
        {isAdmin && !isMe && (
          <button onClick={() => setConfirmK(m)} style={{ position:"absolute", top:8, right:8, background:"none", border:"none", color:C.textMuted, fontSize:12, cursor:"pointer", transition:"color .15s" }}
            onMouseEnter={e=>e.target.style.color=C.red} onMouseLeave={e=>e.target.style.color=C.textMuted}>✕</button>
        )}
        <div style={{ position:"relative", width:42, height:42, margin:"0 auto 8px" }}>
          <div style={{ width:42, height:42, borderRadius:"50%", background: AVATARS[i % AVATARS.length], display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize:16 }}>
            {m.name[0]}
          </div>
          <div className={on?"dot-on":"dot-off"} style={{ position:"absolute", bottom:1, right:1 }} />
        </div>
        <div style={{ fontSize:13, fontWeight:700, color:C.text }}>
          {m.name}{isMe && <span style={{ fontSize:9, color:C.accent, marginLeft:3 }}>나</span>}
        </div>
        <div style={{ fontSize:10, color: on?C.green:C.textMuted, marginTop:2, fontWeight:600 }}>
          {on?"● 접속 중":"○ 오프라인"}
        </div>
        {m.studentId && <div style={{ fontSize:10, color:C.textMuted, marginTop:1 }}>{m.studentId}</div>}
      </div>
    );
  }

  return (
    <div style={{ maxWidth:720, margin:"0 auto" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18, flexWrap:"wrap", gap:8 }}>
        <PH title="반 인원" sub={`${user.classCode} · 총 ${members.length}명`} />
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ padding:"5px 11px", borderRadius:16, background:"#ecfdf5", color:C.green, fontSize:12, fontWeight:700 }}>● {online.length}명 접속 중</span>
          {!isAdmin
            ? <button className="btn btn-ghost" onClick={() => setShowAdmin(!showAdmin)} style={{ fontSize:12 }}>🔑 관리자</button>
            : <span style={{ padding:"5px 11px", borderRadius:16, background:"#fffbeb", color:C.gold, fontSize:12, fontWeight:700 }}>👑 관리자</span>
          }
        </div>
      </div>

      {showAdmin && !isAdmin && (
        <div className="card" style={{ padding:16, marginBottom:16, animation:"popIn .2s ease", borderTop:`3px solid ${C.gold}` }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:10 }}>🔑 관리자 코드 입력</div>
          <div style={{ display:"flex", gap:8 }}>
            <input className="field" type="password" value={adminInput} onChange={e=>setAdminInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&tryAdmin()} placeholder="관리자 코드 8자리" style={{ flex:1 }} />
            <button className="btn btn-navy" onClick={tryAdmin}>확인</button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ padding:18, marginBottom:18, borderTop:`3px solid ${C.gold}`, animation:"popIn .2s ease" }}>
          <div style={{ fontSize:13, fontWeight:800, color:C.gold, marginBottom:12 }}>👑 관리자 패널</div>
          <div style={{ marginBottom:6 }}>
            <label style={LBL}>반 코드 변경</label>
            <div style={{ display:"flex", gap:8 }}>
              <input className="field" value={newCode} onChange={e=>setNewCode(e.target.value.toUpperCase())} placeholder="새 코드 (4자 이상)" style={{ flex:1, letterSpacing:2 }} />
              <button className="btn btn-navy" onClick={handleChangeCode}>변경</button>
            </div>
          </div>
          <p style={{ fontSize:11, color:C.textMuted }}>⚠️ 변경 후 친구들에게 새 코드를 알려주세요</p>
        </div>
      )}

      {/* 강퇴 확인 모달 */}
      {confirmK && (
        <div onClick={() => setConfirmK(null)} style={{ position:"fixed", inset:0, background:"rgba(15,31,61,.5)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999, padding:20 }}>
          <div onClick={e=>e.stopPropagation()} className="card" style={{ padding:24, maxWidth:300, width:"100%", animation:"popIn .2s ease" }}>
            <div style={{ fontSize:15, fontWeight:800, color:C.text, marginBottom:6 }}>강퇴 확인</div>
            <div style={{ fontSize:13, color:C.textSub, marginBottom:18 }}><strong>{confirmK.name}</strong>님을 강퇴할까요?</div>
            <div style={{ display:"flex", gap:8 }}>
              <button className="btn btn-danger" onClick={() => handleKick(confirmK)} style={{ flex:1 }}>강퇴</button>
              <button className="btn btn-ghost" onClick={() => setConfirmK(null)} style={{ flex:1 }}>취소</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign:"center", padding:"60px 0" }}><div style={{ fontSize:34, animation:"float 1.5s ease-in-out infinite" }}>👥</div></div>
      ) : members.length === 0 ? (
        <EF icon="👥" text="아직 아무도 없어요" sub="친구들에게 반 코드를 공유해요!" />
      ) : (
        <>
          {online.length > 0 && (
            <section style={{ marginBottom:20 }}>
              <GL>접속 중 ({online.length})</GL>
              <div style={{ display:"grid", gridTemplateColumns: isDesktop?"repeat(4,1fr)":"repeat(3,1fr)", gap:10 }}>
                {online.map((m,i) => <MCard key={m.id} m={m} i={i} />)}
              </div>
            </section>
          )}
          {offline.length > 0 && (
            <section>
              <GL faded>오프라인 ({offline.length})</GL>
              <div style={{ display:"grid", gridTemplateColumns: isDesktop?"repeat(4,1fr)":"repeat(3,1fr)", gap:10 }}>
                {offline.map((m,i) => <MCard key={m.id} m={m} i={online.length+i} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공통 컴포넌트
// ══════════════════════════════════════════════════════
function PH({ title, sub }) {
  return (
    <div>
      <h2 style={{ fontSize:17, fontWeight:900, color:C.text }}>{title}</h2>
      {sub && <p style={{ fontSize:12, color:C.textMuted, marginTop:2 }}>{sub}</p>}
    </div>
  );
}

function SH({ title, onMore }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
      <div style={{ fontSize:13, fontWeight:800, color:C.text }}>{title}</div>
      <button onClick={onMore} style={{ background:"none", border:"none", fontSize:12, color:C.textMuted, fontWeight:600, cursor:"pointer" }}>더보기 →</button>
    </div>
  );
}

function GL({ children, faded }) {
  return <div style={{ fontSize:11, fontWeight:700, color: faded?C.textMuted:C.textSub, letterSpacing:1.5, marginBottom:10, textTransform:"uppercase" }}>{children}</div>;
}

function Muted({ children, style: s }) {
  return <div style={{ fontSize:12, color:C.textMuted, textAlign:"center", padding:"16px 0", ...s }}>{children}</div>;
}

function EF({ icon, text, sub }) {
  return (
    <div style={{ textAlign:"center", padding:"60px 20px", color:C.textMuted }}>
      <div style={{ fontSize:42, marginBottom:10 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:C.textSub, marginBottom:4 }}>{text}</div>
      {sub && <div style={{ fontSize:12 }}>{sub}</div>}
    </div>
  );
}

const LBL = { display:"block", fontSize:11, fontWeight:700, color:C.textSub, letterSpacing:.5, marginBottom:6 };