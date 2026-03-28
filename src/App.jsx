import { useState, useEffect, useCallback, useRef } from "react";
import {
  collection, addDoc, getDocs, deleteDoc, setDoc,
  doc, getDoc, query, where, orderBy, serverTimestamp,
  onSnapshot, updateDoc, Timestamp,
} from "firebase/firestore";
import { db } from "./services/firebase";

// ── 상수 ──────────────────────────────────────────────
const SCHEDULE_TYPES = ["수행평가", "시험", "행사", "과제", "기타"];
const TYPE_META = {
  수행평가: { color: "#f59e0b", bg: "#fef9ec", icon: "✏️" },
  시험:     { color: "#ef4444", bg: "#fff1f1", icon: "📝" },
  행사:     { color: "#8b5cf6", bg: "#f5f0ff", icon: "🎉" },
  과제:     { color: "#3b82f6", bg: "#eff6ff", icon: "📚" },
  기타:     { color: "#6b7280", bg: "#f9fafb", icon: "📌" },
};
const MEAL_META = {
  조식: { icon: "🌅", color: "#f59e0b", bg: "#fef9ec", label: "조식 (아침)" },
  중식: { icon: "☀️", color: "#10b981", bg: "#d1fae5", label: "중식 (점심)" },
  석식: { icon: "🌙", color: "#6366f1", bg: "#ede9fe", label: "석식 (저녁)" },
};
const DAY_KR   = ["일","월","화","수","목","금","토"];
const MONTH_KR = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
// 온라인 기준: 마지막 heartbeat 이후 2분
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
const HEARTBEAT_INTERVAL  = 45 * 1000;

const storage = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

function getTodayDash() { return new Date().toISOString().slice(0,10); }

function getWeekDates() {
  const today = new Date();
  const day   = today.getDay();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  return Array.from({length:5}, (_,i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d.toISOString().slice(0,10).replace(/-/g,"");
  });
}

function getDday(dateStr) {
  const diff = Math.ceil((new Date(dateStr) - new Date(getTodayDash())) / 86400000);
  if (diff === 0) return { label:"D-Day", color:"#ef4444", urgent:true };
  if (diff > 0 && diff <= 7) return { label:`D-${diff}`, color:"#f59e0b", urgent:true };
  if (diff > 0) return { label:`D-${diff}`, color:"#94a3b8", urgent:false };
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

async function fetchWeekMeals() {
  const dates   = getWeekDates();
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
    const from = `${year}${m}01`;
    const to   = `${year}${m}${String(last).padStart(2,"0")}`;
    const res  = await fetch(`/api/schedule?from=${from}&to=${to}`);
    const data = await res.json();
    const rows = data?.SchoolSchedule?.[1]?.row;
    if (!rows) return [];
    return rows.map(r => ({
      date:  `${r.AA_YMD.slice(0,4)}-${r.AA_YMD.slice(4,6)}-${r.AA_YMD.slice(6,8)}`,
      title: r.EVENT_NM,
    }));
  } catch { return []; }
}

// ── Firebase 반 코드 검증 ──────────────────────────────
async function verifyOrCreateClass(grade, cls, code) {
  const classId  = `${grade}-${cls}`;
  const classRef = doc(db, "classes", classId);
  const snap     = await getDoc(classRef);
  if (!snap.exists()) {
    await setDoc(classRef, { code, createdAt: serverTimestamp() });
    return { ok: true, isNew: true };
  }
  const savedCode = snap.data().code;
  if (savedCode !== code) return { ok: false };
  return { ok: true, isNew: false };
}

// ── 멤버 등록 + 온라인 상태 ──────────────────────────────
async function registerMember(classCode, grade, cls, name) {
  const memberId  = `${classCode}_${name}`;
  const memberRef = doc(db, "members", memberId);
  await setDoc(memberRef, {
    name, grade, cls, classCode,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
    online:   true,
  }, { merge: true });
  return memberId;
}

async function heartbeat(memberId) {
  try {
    await updateDoc(doc(db, "members", memberId), {
      lastSeen: serverTimestamp(),
      online:   true,
    });
  } catch {}
}

async function setOffline(memberId) {
  try {
    await updateDoc(doc(db, "members", memberId), { online: false });
  } catch {}
}

// ══════════════════════════════════════════════════════
// CSS
// ══════════════════════════════════════════════════════
const GLOBAL_CSS = `
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  html { width:100%; height:100%; }
  body { width:100%; height:100%; background:#f0f4ff; font-family:'Pretendard','Noto Sans KR',sans-serif; overflow:hidden; }
  #root { width:100%; height:100%; display:flex; flex-direction:column; }
  input,textarea,select,button { font-family:inherit; }
  input:focus,textarea:focus,select:focus { outline:none; }
  ::placeholder { color:#94a3b8; }
  ::-webkit-scrollbar { width:5px; }
  ::-webkit-scrollbar-thumb { background:#dbeafe; border-radius:4px; }
  @keyframes fadeUp  { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
  @keyframes popIn   { 0%{opacity:0;transform:scale(.94)} 100%{opacity:1;transform:scale(1)} }
  @keyframes float   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
  @keyframes pulse   { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:.85;transform:scale(1.04)} }
  @keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(12px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  @keyframes spin    { to{transform:rotate(360deg)} }
  @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.3} }
  .card { background:#fff; border-radius:16px; border:1px solid #e8eef8; box-shadow:0 2px 12px rgba(79,140,255,.06); }
  .hover-card { transition:transform .18s,box-shadow .18s; cursor:pointer; }
  .hover-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(79,140,255,.12); }
  .tag { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:20px; font-size:11px; font-weight:700; }
  .input-field { width:100%; padding:12px 14px; background:#f8faff; border:1.5px solid #e8eef8; border-radius:10px; font-size:14px; color:#1e293b; transition:border-color .2s,box-shadow .2s; }
  .input-field:focus { border-color:#4f8cff; box-shadow:0 0 0 3px rgba(79,140,255,.1); background:#fff; }
  .btn-primary { padding:12px 20px; border:none; border-radius:10px; background:linear-gradient(135deg,#4f8cff,#7c3aed); color:#fff; font-size:14px; font-weight:700; cursor:pointer; box-shadow:0 4px 14px rgba(79,140,255,.3); transition:transform .15s,box-shadow .15s,opacity .15s; }
  .btn-primary:hover { transform:translateY(-1px); }
  .btn-primary:active { transform:scale(.97); }
  .btn-primary:disabled { opacity:.65; cursor:not-allowed; transform:none; }
  .side-nav-btn { width:100%; padding:10px 14px; border-radius:10px; border:none; display:flex; align-items:center; gap:10px; font-size:14px; font-weight:500; cursor:pointer; transition:all .15s; text-align:left; margin-bottom:2px; background:transparent; color:#64748b; }
  .side-nav-btn.active { background:#eff6ff; color:#1d4ed8; font-weight:700; }
  .side-nav-btn:hover:not(.active) { background:#f8faff; color:#1e293b; }
  .bottom-tab { display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 0 6px; border:none; background:#fff; cursor:pointer; transition:background .15s; flex:1; }
  .bottom-tab.active { background:#eff6ff; }
  .bottom-tab:hover { background:#f8faff; }
  .login-select { width:100%; padding:12px 14px; background:rgba(255,255,255,.15); border:1.5px solid rgba(255,255,255,.25); border-radius:10px; color:#f1f5f9; font-size:14px; cursor:pointer; appearance:none; -webkit-appearance:none; }
  .login-select option { background:#1e293b; color:#f1f5f9; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:3px; width:100%; }
  .cal-cell { width:100%; min-height:68px; padding:5px 4px; border-radius:8px; border:1px solid #f0f4ff; background:#fafbff; transition:background .15s; cursor:pointer; overflow:hidden; }
  .cal-cell:hover { background:#eff6ff; }
  .cal-cell.today { border:2px solid #4f8cff !important; background:#eff6ff; }
  .cal-cell.selected { border:2px solid #4f8cff !important; background:#eff6ff; }
  .cal-cell.empty { background:transparent !important; border-color:transparent !important; cursor:default; }
  .cal-cell.weekend-cell { background:#fafafa; border-color:#f5f5f5; }
  .cal-cell.weekend-cell:hover { background:#f5f5f5; }
  .online-dot { width:9px; height:9px; border-radius:50%; background:#10b981; border:2px solid #fff; animation:blink 2s ease-in-out infinite; }
  .offline-dot { width:9px; height:9px; border-radius:50%; background:#e2e8f0; border:2px solid #fff; }
  .page-padding { padding:16px; }
  @media(min-width:640px)  { .page-padding { padding:20px 24px; } }
  @media(min-width:1024px) { .page-padding { padding:24px 32px; } }
`;

// ══════════════════════════════════════════════════════
// 앱 진입점
// ══════════════════════════════════════════════════════
export default function App() {
  const [user, setUser] = useState(() => storage.get("sjdshs_user"));
  const [page, setPage] = useState("home");
  return (
    <>
      <style>{GLOBAL_CSS}</style>
      {!user
        ? <LoginPage onLogin={(u) => { storage.set("sjdshs_user", u); setUser(u); }} />
        : <MainApp user={user} page={page} setPage={setPage} onLogout={() => { storage.set("sjdshs_user", null); setUser(null); }} />
      }
    </>
  );
}

// ══════════════════════════════════════════════════════
// 로그인
// ══════════════════════════════════════════════════════
function LoginPage({ onLogin }) {
  const [name,  setName]  = useState("");
  const [code,  setCode]  = useState("");
  const [grade, setGrade] = useState("1");
  const [cls,   setCls]   = useState("1");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  async function submit() {
    if (!name.trim())           { setErr("이름을 입력해주세요"); return; }
    if (code.trim().length < 4) { setErr("반 코드는 4자 이상이에요"); return; }
    setBusy(true);
    try {
      const result = await verifyOrCreateClass(grade, cls, code.trim().toUpperCase());
      if (!result.ok) {
        setErr(`${grade}학년 ${cls}반 코드가 틀렸어요. 반 친구에게 코드를 받아요!`);
        setBusy(false);
        return;
      }
      const classCode = code.trim().toUpperCase();
      const memberId  = await registerMember(classCode, grade, cls, name.trim());
      onLogin({ name:name.trim(), classCode, grade, cls, memberId, isNew:result.isNew });
    } catch(e) {
      console.error(e);
      setErr("오류가 발생했어요. 다시 시도해줘요.");
      setBusy(false);
    }
  }

  return (
    <div style={{ width:"100%", minHeight:"100dvh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0a0f1e", padding:20, position:"relative", overflow:"hidden" }}>
      {[[220,"#4f8cff","12%","8%",3.8],[160,"#7c3aed","78%","72%",4.5],[260,"#06b6d4","68%","12%",5.2],[110,"#f59e0b","22%","78%",3.2]].map(([sz,cl,top,left,dur],i) => (
        <div key={i} style={{ position:"absolute", width:sz, height:sz, borderRadius:"50%", background:cl, opacity:.07, top, left, filter:"blur(70px)", animation:`pulse ${dur}s ease-in-out infinite`, animationDelay:`${i*.6}s`, pointerEvents:"none" }} />
      ))}
      <div style={{ width:"100%", maxWidth:400, position:"relative", zIndex:1, animation:"fadeUp .5s ease" }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontSize:52, display:"inline-block", marginBottom:10, animation:"float 3.5s ease-in-out infinite" }}>🏫</div>
          <h1 style={{ fontSize:26, fontWeight:900, color:"#fff", letterSpacing:-1, lineHeight:1.15 }}>
            세종대성<br/>
            <span style={{ background:"linear-gradient(90deg,#60a5fa,#a78bfa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>클래스</span>
          </h1>
          <p style={{ color:"#475569", fontSize:12, marginTop:6 }}>우리 반 전용 일정 · 공지 · 급식 · 학사일정</p>
        </div>
        <div style={{ background:"rgba(255,255,255,.05)", backdropFilter:"blur(24px)", border:"1px solid rgba(255,255,255,.1)", borderRadius:20, padding:"24px 20px" }}>
          <div style={{ marginBottom:12 }}>
            <label style={LOGIN_LBL}>이름</label>
            <input value={name} placeholder="홍길동" onChange={e=>{setName(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()}
              style={{ width:"100%", padding:"12px 14px", background:"rgba(255,255,255,.07)", border:"1.5px solid rgba(255,255,255,.13)", borderRadius:10, color:"#f1f5f9", fontSize:14 }} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
            <div>
              <label style={LOGIN_LBL}>학년</label>
              <div style={{ position:"relative" }}>
                <select value={grade} onChange={e=>setGrade(e.target.value)} className="login-select">
                  {["1","2","3"].map(g=><option key={g} value={g}>{g}학년</option>)}
                </select>
                <div style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"rgba(255,255,255,.5)", fontSize:11 }}>▾</div>
              </div>
            </div>
            <div>
              <label style={LOGIN_LBL}>반 (1~10반)</label>
              <div style={{ position:"relative" }}>
                <select value={cls} onChange={e=>setCls(e.target.value)} className="login-select">
                  {Array.from({length:10},(_,i)=>i+1).map(c=><option key={c} value={String(c)}>{c}반</option>)}
                </select>
                <div style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"rgba(255,255,255,.5)", fontSize:11 }}>▾</div>
              </div>
            </div>
          </div>
          <div style={{ marginBottom:8 }}>
            <label style={LOGIN_LBL}>반 코드</label>
            <input value={code} placeholder="4자 이상 (처음이면 새 코드 생성)" onChange={e=>{setCode(e.target.value.toUpperCase());setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()}
              style={{ width:"100%", padding:"12px 14px", background:"rgba(255,255,255,.07)", border:"1.5px solid rgba(255,255,255,.13)", borderRadius:10, color:"#f1f5f9", fontSize:14, letterSpacing:2, fontWeight:700 }} />
            <p style={{ fontSize:10, color:"rgba(255,255,255,.3)", marginTop:4, lineHeight:1.5 }}>💡 처음 입력한 코드가 우리 반 코드가 됩니다</p>
          </div>
          {err && <div style={{ fontSize:12, color:"#fca5a5", background:"rgba(239,68,68,.12)", borderRadius:8, padding:"9px 12px", marginBottom:12, lineHeight:1.5 }}>⚠️ {err}</div>}
          <button className="btn-primary" onClick={submit} disabled={busy} style={{ width:"100%", marginTop:4, padding:"13px", fontSize:14, fontWeight:800 }}>
            {busy
              ? <span style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}><span style={{ width:14, height:14, border:"2px solid rgba(255,255,255,.3)", borderTopColor:"#fff", borderRadius:"50%", animation:"spin .7s linear infinite", display:"inline-block" }} />확인 중...</span>
              : "입장하기 →"
            }
          </button>
        </div>
      </div>
    </div>
  );
}
const LOGIN_LBL = { display:"block", fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.55)", letterSpacing:1, marginBottom:6 };

// ══════════════════════════════════════════════════════
// 메인 앱 (heartbeat 포함)
// ══════════════════════════════════════════════════════
function MainApp({ user, page, setPage, onLogout }) {
  const { isMobile, isDesktop } = useBreakpoint();
  const showSidebar   = isDesktop;
  const showBottomNav = !isDesktop;

  const [schedules, setSchedules] = useState([]);
  const [notices,   setNotices]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [toast,     setToast]     = useState(null);
  const hbRef = useRef(null);

  const showToast = useCallback((msg, type="info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  }, []);

  // heartbeat - 45초마다 lastSeen 갱신
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
        const [ss, ns] = await Promise.all([
          getDocs(query(collection(db,"schedules"), where("classCode","==",user.classCode), orderBy("date","asc"))),
          getDocs(query(collection(db,"notices"),   where("classCode","==",user.classCode), orderBy("createdAt","desc"))),
        ]);
        setSchedules(ss.docs.map(d => ({ id:d.id, ...d.data() })));
        setNotices(ns.docs.map(d => ({ id:d.id, ...d.data() })));
      } catch(e) { console.error(e); showToast("❌ 데이터 로드 실패","error"); }
      setLoading(false);
    })();
  }, [user.classCode]);

  const todayStr = getTodayDash();
  const upcoming = schedules.filter(s => s.date >= todayStr && !isWeekend(s.date)).sort((a,b) => a.date.localeCompare(b.date));
  const todaySch = schedules.filter(s => s.date === todayStr && !isWeekend(s.date));

  const NAV = [
    { id:"home",     icon:"🏠", label:"홈" },
    { id:"schedule", icon:"📅", label:"일정" },
    { id:"academic", icon:"🗓", label:"학사일정" },
    { id:"notice",   icon:"📢", label:"공지" },
    { id:"lunch",    icon:"🍱", label:"급식" },
    { id:"members",  icon:"👥", label:"반 인원" },
  ];

  const pages = {
    home:     <HomePage     user={user} schedules={schedules} notices={notices} upcoming={upcoming} todaySch={todaySch} setPage={setPage} loading={loading} />,
    schedule: <SchedulePage user={user} schedules={schedules} setSchedules={setSchedules} showToast={showToast} />,
    academic: <AcademicPage />,
    notice:   <NoticePage   user={user} notices={notices} setNotices={setNotices} showToast={showToast} />,
    lunch:    <LunchPage />,
    members:  <MembersPage  user={user} />,
  };

  return (
    <div style={{ width:"100%", height:"100vh", display:"flex", background:"#f0f4ff", overflow:"hidden" }}>
      {toast && (
        <div style={{ position:"fixed", bottom: showBottomNav?72:20, left:"50%", transform:"translateX(-50%)", background: toast.type==="error"?"#ef4444":"#1e293b", color:"#fff", padding:"10px 20px", borderRadius:30, fontSize:13, fontWeight:600, zIndex:9999, whiteSpace:"nowrap", boxShadow:"0 8px 28px rgba(0,0,0,.22)", animation:"toastIn .25s ease" }}>
          {toast.msg}
        </div>
      )}

      {showSidebar && (
        <aside style={{ width:240, height:"100vh", background:"#fff", borderRight:"1px solid #e8eef8", display:"flex", flexDirection:"column", boxShadow:"2px 0 16px rgba(79,140,255,.06)", flexShrink:0, overflow:"hidden" }}>
          <div style={{ padding:"22px 18px 14px", borderBottom:"1px solid #f0f4ff" }}>
            <div style={{ fontSize:26, marginBottom:6 }}>🏫</div>
            <div style={{ fontSize:14, fontWeight:900, color:"#1e293b" }}>세종대성 클래스</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>{user.classCode} · {user.grade}학년 {user.cls}반</div>
          </div>
          <nav style={{ flex:1, padding:"10px", overflowY:"auto" }}>
            {NAV.map(n => (
              <button key={n.id} className={`side-nav-btn${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:17 }}>{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
          <div style={{ padding:"12px", borderTop:"1px solid #f0f4ff" }}>
            <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:9 }}>
              <div style={{ position:"relative" }}>
                <div style={{ width:34, height:34, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:13 }}>{user.name[0]}</div>
                <div className="online-dot" style={{ position:"absolute", bottom:0, right:0 }} />
              </div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{user.grade}학년 {user.cls}반</div>
              </div>
            </div>
            <button onClick={onLogout} style={{ width:"100%", padding:"8px", borderRadius:8, border:"1px solid #e8eef8", background:"#f8faff", color:"#94a3b8", fontSize:12, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e=>{e.currentTarget.style.background="#fff1f1";e.currentTarget.style.color="#ef4444";e.currentTarget.style.borderColor="#fecaca";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#f8faff";e.currentTarget.style.color="#94a3b8";e.currentTarget.style.borderColor="#e8eef8";}}>
              로그아웃
            </button>
          </div>
        </aside>
      )}

      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
        <header style={{ background: showSidebar?"#fff":"linear-gradient(135deg,#1d4ed8,#4f46e5)", borderBottom: showSidebar?"1px solid #e8eef8":"none", padding: showSidebar?"12px 28px":"11px 18px", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow: showSidebar?"none":"0 3px 14px rgba(29,78,216,.25)", flexShrink:0 }}>
          {showSidebar ? (
            <>
              <div>
                <h2 style={{ fontSize:16, fontWeight:900, color:"#1e293b" }}>
                  {{ home:"🏠 홈", schedule:"📅 일정 관리", academic:"🗓 학사일정", notice:"📢 공지 공유", lunch:"🍱 급식 메뉴", members:"👥 반 인원" }[page]}
                </h2>
                <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>
                  {new Date().toLocaleDateString("ko-KR",{ year:"numeric", month:"long", day:"numeric", weekday:"long" })}
                </div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ position:"relative" }}>
                  <div style={{ width:32, height:32, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:12 }}>{user.name[0]}</div>
                  <div className="online-dot" style={{ position:"absolute", bottom:0, right:0 }} />
                </div>
                <div style={{ fontSize:12, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
              </div>
            </>
          ) : (
            <>
              <div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,.55)", letterSpacing:1.5, fontWeight:700 }}>{user.grade}학년 {user.cls}반 · {user.classCode}</div>
                <div style={{ fontSize:15, fontWeight:800, color:"#fff" }}>안녕하세요, {user.name}님 👋</div>
              </div>
              <button onClick={onLogout} style={{ background:"rgba(255,255,255,.15)", border:"none", padding:"6px 11px", borderRadius:18, color:"rgba(255,255,255,.9)", fontSize:11, fontWeight:600, cursor:"pointer" }}>나가기</button>
            </>
          )}
        </header>

        <main style={{ flex:1, overflowY:"auto", paddingBottom: showBottomNav?68:0 }} className="page-padding">
          {loading
            ? <div style={{ textAlign:"center", padding:"70px 20px" }}><div style={{ fontSize:38, animation:"float 1.5s ease-in-out infinite" }}>⏳</div><div style={{ fontSize:13, color:"#94a3b8", marginTop:12, fontWeight:600 }}>불러오는 중...</div></div>
            : <div key={page} style={{ animation:"slideUp .3s ease" }}>{pages[page]}</div>
          }
        </main>

        {showBottomNav && (
          <nav style={{ position:"fixed", bottom:0, left:0, right:0, background:"#fff", borderTop:"1px solid #e8eef8", display:"flex", boxShadow:"0 -3px 14px rgba(0,0,0,.06)", zIndex:100 }}>
            {NAV.map(n => (
              <button key={n.id} className={`bottom-tab${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize: isMobile?18:20 }}>{n.icon}</span>
                <span style={{ fontSize: isMobile?(n.label.length>3?7:8):9, fontWeight: page===n.id?800:500, color: page===n.id?"#1d4ed8":"#94a3b8" }}>{n.label}</span>
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
  const urgentSchedules = upcoming.filter(s => getDday(s.date).urgent).slice(0,4);

  return (
    <div style={{ width:"100%", maxWidth:960, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(135deg,#1d4ed8,#4f46e5 55%,#7c3aed)", borderRadius:18, padding: isDesktop?"24px 28px":"18px", marginBottom:18, color:"#fff", boxShadow:"0 10px 32px rgba(29,78,216,.25)", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-20, top:-20, width:150, height:150, borderRadius:"50%", background:"rgba(255,255,255,.07)", pointerEvents:"none" }} />
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.55)", fontWeight:700, letterSpacing:2, marginBottom:3 }}>TODAY</div>
          <div style={{ fontSize: isDesktop?22:19, fontWeight:900, letterSpacing:-.5, marginBottom: todaySch.length?10:0 }}>
            {now.getMonth()+1}월 {now.getDate()}일 {dayNames[now.getDay()]}
          </div>
          {todaySch.length > 0
            ? todaySch.map(s => {
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ background:"rgba(255,255,255,.14)", backdropFilter:"blur(10px)", borderRadius:9, padding:"8px 12px", display:"flex", alignItems:"center", gap:9, marginTop:6 }}>
                  <span style={{ fontSize:14 }}>{meta.icon}</span>
                  <span style={{ fontSize:13, fontWeight:600, flex:1 }}>{s.title}</span>
                  <span className="tag" style={{ background:"rgba(255,255,255,.18)", color:"#fff" }}>{s.type}</span>
                </div>
              );
            })
            : <div style={{ fontSize:12, color:"rgba(255,255,255,.45)", marginTop:4 }}>오늘 등록된 일정이 없어요 😌</div>
          }
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:14 }}>
        <div className="card" style={{ padding:18 }}>
          <SectionHeader title="⏳ 다가오는 일정" onMore={() => setPage("schedule")} />
          {upcoming.length === 0
            ? <EmptyMini icon="📅" text="다가오는 평일 일정이 없어요" />
            : upcoming.slice(0,4).map(s => {
              const dd   = getDday(s.date);
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid #f8faff" }}>
                  <div style={{ width:34, height:34, borderRadius:8, background:meta.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, flexShrink:0 }}>{meta.icon}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"#1e293b", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.title}</div>
                    <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>{s.date.slice(5).replace("-","/")} · {s.authorName}</div>
                  </div>
                  <span style={{ fontSize:12, fontWeight:900, color:dd.color, flexShrink:0 }}>{dd.label}</span>
                </div>
              );
            })
          }
        </div>

        <div className="card" style={{ padding:18 }}>
          <SectionHeader title="📢 최근 공지" onMore={() => setPage("notice")} />
          {notices.length === 0
            ? <EmptyMini icon="📢" text="공지가 없어요" />
            : notices.slice(0,3).map(n => (
              <div key={n.id} style={{ padding:"8px 0", borderBottom:"1px solid #f8faff" }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b", marginBottom:2 }}>{n.title}</div>
                <div style={{ fontSize:12, color:"#64748b", lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{n.content}</div>
                <div style={{ fontSize:10, color:"#cbd5e1", marginTop:3 }}>{n.authorName}</div>
              </div>
            ))
          }
        </div>

        {urgentSchedules.map((s,i) => {
          const dd   = getDday(s.date);
          const meta = TYPE_META[s.type] || TYPE_META["기타"];
          return (
            <div key={s.id} className="card hover-card" onClick={() => setPage("schedule")} style={{ padding:18, borderLeft:`3px solid ${meta.color}`, animation:`popIn .3s ease ${i*.08}s both` }}>
              <span className="tag" style={{ background:meta.bg, color:meta.color, marginBottom:8 }}>{meta.icon} {s.type}</span>
              <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", marginBottom:2 }}>{s.title}</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:10 }}>{s.date}</div>
              <div style={{ fontSize:30, fontWeight:900, color:dd.color, letterSpacing:-1 }}>{dd.label}</div>
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

  const allUpcoming = schedules.filter(s => s.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date));
  const allPast     = schedules.filter(s => s.date < todayStr).sort((a,b) => b.date.localeCompare(a.date));
  const upcoming = hideWeekend ? allUpcoming.filter(s => !isWeekend(s.date)) : allUpcoming;
  const past     = hideWeekend ? allPast.filter(s => !isWeekend(s.date))     : allPast;

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
    <div style={{ width:"100%", maxWidth:820, margin:"0 auto" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18, flexWrap:"wrap", gap:8 }}>
        <div>
          <h2 style={{ fontSize:18, fontWeight:900, color:"#1e293b" }}>일정 관리</h2>
          <p style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>수행평가·시험·행사를 등록해요</p>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <button onClick={() => setHideWeekend(!hideWeekend)} style={{ padding:"6px 12px", border:"none", borderRadius:18, cursor:"pointer", fontSize:11, fontWeight:700, background: hideWeekend?"#eff6ff":"#f1f5f9", color: hideWeekend?"#1d4ed8":"#94a3b8", transition:"all .15s" }}>
            {hideWeekend ? "주말 제외 ✓" : "주말 포함"}
          </button>
          <button onClick={() => setShowForm(!showForm)} style={{ padding:"8px 16px", border:"none", borderRadius:10, background: showForm?"#f1f5f9":"linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm?"#64748b":"#fff", fontSize:13, fontWeight:700, cursor:"pointer", transition:"all .2s" }}>
            {showForm ? "✕ 닫기" : "+ 추가"}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="card" style={{ padding:20, marginBottom:18, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ display:"grid", gridTemplateColumns: isMobile?"1fr":"2fr 1fr 1fr", gap:10, marginBottom:12 }}>
            <div>
              <label style={LBL}>제목</label>
              <input className="input-field" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="예: 영어 수행평가" />
            </div>
            <div>
              <label style={LBL}>날짜</label>
              <input className="input-field" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})} />
            </div>
            <div>
              <label style={LBL}>유형</label>
              <select className="input-field" value={form.type} onChange={e=>setForm({...form,type:e.target.value})} style={{ background:"#f8faff" }}>
                {SCHEDULE_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <button className="btn-primary" onClick={add} disabled={saving}>{saving?"저장 중...":"일정 추가하기"}</button>
        </div>
      )}

      {upcoming.length > 0 && (
        <section style={{ marginBottom:22 }}>
          <GroupLabel>다가오는 일정 ({upcoming.length})</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:10 }}>
            {upcoming.map(s=><SchedCard key={s.id} s={s} user={user} onDel={del} />)}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <GroupLabel faded>지난 일정</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:8, opacity:.5 }}>
            {past.slice(0,6).map(s=><SchedCard key={s.id} s={s} user={user} onDel={del} past />)}
          </div>
        </section>
      )}
      {schedules.length === 0 && <EmptyFull icon="📅" text="아직 일정이 없어요" sub="위 버튼으로 첫 일정을 추가해보세요!" />}
    </div>
  );
}

function SchedCard({ s, user, onDel, past }) {
  const dd   = getDday(s.date);
  const meta = TYPE_META[s.type] || TYPE_META["기타"];
  return (
    <div className="card hover-card" style={{ padding:14, borderLeft:`3px solid ${dd.urgent&&!past?meta.color:"#f0f4ff"}` }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:7 }}>
        <span className="tag" style={{ background:meta.bg, color:meta.color }}>{meta.icon} {s.type}</span>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          {!past && <span style={{ fontSize:12, fontWeight:900, color:dd.color }}>{dd.label}</span>}
          {s.authorName === user.name && (
            <button onClick={()=>onDel(s.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:13, cursor:"pointer", padding:2, lineHeight:1, transition:"color .15s" }}
              onMouseEnter={e=>e.currentTarget.style.color="#ef4444"} onMouseLeave={e=>e.currentTarget.style.color="#e2e8f0"}>✕</button>
          )}
        </div>
      </div>
      <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", marginBottom:2 }}>{s.title}</div>
      <div style={{ fontSize:11, color:"#94a3b8" }}>{s.date.slice(5).replace("-","/")} · {DAY_KR[new Date(s.date).getDay()]} · {s.authorName}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 학사일정 달력
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
    (async () => {
      setLoading(true);
      const data = await fetchMonthSchedule(year, month);
      setEvents(data);
      setLoading(false);
    })();
  }, [year, month]);

  function prevMonth() { if (month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1); }
  function nextMonth() { if (month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1); }

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay    = new Date(year, month-1, 1).getDay();
  const cells = [...Array(firstDay).fill(null), ...Array.from({length:daysInMonth},(_,i)=>i+1)];
  while (cells.length < 42) cells.push(null);

  const todayDash = getTodayDash();

  function eventsForDay(day) {
    if (!day) return [];
    const str = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    return events.filter(e => e.date === str);
  }

  const selectedDate   = selected ? `${year}-${String(month).padStart(2,"0")}-${String(selected).padStart(2,"0")}` : null;
  const selectedEvents = selectedDate ? events.filter(e => e.date === selectedDate) : [];

  return (
    <div style={{ width:"100%", maxWidth:960, margin:"0 auto" }}>
      <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 260px":"1fr", gap:18 }}>
        <div className="card" style={{ padding:18 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
            <button onClick={prevMonth} style={{ background:"#f0f4ff", border:"none", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:17, color:"#4f8cff", display:"flex", alignItems:"center", justifyContent:"center" }}>‹</button>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:16, fontWeight:900, color:"#1e293b" }}>{year}년 {MONTH_KR[month-1]}</div>
              {loading && <div style={{ fontSize:10, color:"#94a3b8" }}>불러오는 중...</div>}
            </div>
            <button onClick={nextMonth} style={{ background:"#f0f4ff", border:"none", width:32, height:32, borderRadius:8, cursor:"pointer", fontSize:17, color:"#4f8cff", display:"flex", alignItems:"center", justifyContent:"center" }}>›</button>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"repeat(7,minmax(0,1fr))", marginBottom:4 }}>
            {DAY_KR.map((d,i) => (
              <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:700, padding:"3px 0", color: i===0?"#ef4444":i===6?"#3b82f6":"#94a3b8" }}>{d}</div>
            ))}
          </div>

          <div className="cal-grid">
            {cells.map((day, idx) => {
              const colIdx = idx % 7;
              const isSun  = colIdx === 0;
              const isSat  = colIdx === 6;
              const isWknd = isSun || isSat;
              if (!day) return <div key={idx} className="cal-cell empty" />;
              const dash    = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
              const dayEvts = eventsForDay(day);
              const isToday = dash === todayDash;
              const isSel   = selected === day;
              return (
                <div key={idx} className={`cal-cell${isWknd?" weekend-cell":""}${isToday?" today":""}${isSel?" selected":""}`}
                  onClick={() => setSelected(isSel?null:day)}>
                  <div style={{ fontSize:11, fontWeight:isToday?800:400, textAlign:"right", marginBottom:2, color: isToday?"#4f8cff":isSun?"#ef4444":isSat?"#3b82f6":"#64748b" }}>{day}</div>
                  {dayEvts.slice(0,isMobile?1:2).map((e,i) => (
                    <div key={i} style={{ fontSize:8, padding:"2px 3px", borderRadius:3, marginBottom:1, background:isWknd?"#e0e7ff":"#dbeafe", color:isWknd?"#6366f1":"#1d4ed8", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontWeight:600 }}>
                      {e.title}
                    </div>
                  ))}
                  {dayEvts.length > (isMobile?1:2) && <div style={{ fontSize:8, color:"#94a3b8", textAlign:"right" }}>+{dayEvts.length-(isMobile?1:2)}</div>}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {selected && (
            <div className="card" style={{ padding:16, animation:"popIn .2s ease", borderTop:"3px solid #4f8cff" }}>
              <div style={{ fontSize:13, fontWeight:800, color:"#1d4ed8", marginBottom:8 }}>
                {month}월 {selected}일 ({DAY_KR[new Date(year,month-1,selected).getDay()]})
              </div>
              {selectedEvents.length === 0
                ? <div style={{ fontSize:12, color:"#cbd5e1", textAlign:"center", padding:"10px 0" }}>학사일정 없음</div>
                : selectedEvents.map((e,i) => (
                  <div key={i} style={{ padding:"7px 9px", borderRadius:8, background:"#eff6ff", marginBottom:5 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{e.title}</div>
                  </div>
                ))
              }
            </div>
          )}
          <div className="card" style={{ padding:16, flex:1, overflowY:"auto", maxHeight: isDesktop?460:280 }}>
            <div style={{ fontSize:13, fontWeight:800, color:"#1e293b", marginBottom:10 }}>{MONTH_KR[month-1]} 학사일정</div>
            {loading ? (
              <div style={{ fontSize:12, color:"#94a3b8", textAlign:"center", padding:"14px 0" }}>불러오는 중...</div>
            ) : events.length === 0 ? (
              <div style={{ fontSize:12, color:"#cbd5e1", textAlign:"center", padding:"14px 0" }}>이달 학사일정 없음</div>
            ) : events.map((e,i) => {
              const d  = new Date(e.date);
              const dd = getDday(e.date);
              return (
                <div key={i} onClick={() => setSelected(d.getDate())}
                  style={{ display:"flex", alignItems:"center", gap:9, padding:"7px 5px", borderRadius:7, marginBottom:2, cursor:"pointer", background: selected===d.getDate()?"#eff6ff":"transparent", transition:"background .15s" }}>
                  <div style={{ minWidth:28, textAlign:"center", flexShrink:0 }}>
                    <div style={{ fontSize:14, fontWeight:900, color: d.getDay()===0?"#ef4444":d.getDay()===6?"#3b82f6":"#4f8cff", lineHeight:1 }}>{d.getDate()}</div>
                    <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600 }}>{DAY_KR[d.getDay()]}</div>
                  </div>
                  <div style={{ flex:1, fontSize:12, fontWeight:600, color:"#1e293b", lineHeight:1.4 }}>{e.title}</div>
                  {!dd.past && <span style={{ fontSize:10, fontWeight:800, color:dd.color, flexShrink:0 }}>{dd.label}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공지
// ══════════════════════════════════════════════════════
function NoticePage({ user, notices, setNotices, showToast }) {
  const { isDesktop } = useBreakpoint();
  const [showForm, setShowForm] = useState(false);
  const [form,    setForm]     = useState({ title:"", content:"" });
  const [saving,  setSaving]   = useState(false);

  async function add() {
    if (!form.title.trim())   { showToast("⚠️ 제목을 입력해주세요","error"); return; }
    if (!form.content.trim()) { showToast("⚠️ 내용을 입력해주세요","error"); return; }
    setSaving(true);
    try {
      const item = { ...form, classCode:user.classCode, authorName:user.name, createdAt:serverTimestamp() };
      const ref  = await addDoc(collection(db,"notices"), item);
      setNotices(p => [{ id:ref.id, ...item, createdAt:Date.now() }, ...p]);
      setForm({ title:"", content:"" });
      setShowForm(false);
      showToast("✅ 공지 등록됨!");
    } catch { showToast("❌ 등록 실패","error"); }
    setSaving(false);
  }

  async function del(id) {
    try { await deleteDoc(doc(db,"notices",id)); setNotices(p=>p.filter(n=>n.id!==id)); showToast("🗑 삭제됐어요"); }
    catch { showToast("❌ 삭제 실패","error"); }
  }

  function fmtDate(val) {
    if (!val) return "";
    try { return (val.toDate?val.toDate():new Date(val)).toLocaleDateString("ko-KR",{month:"short",day:"numeric"}); } catch { return ""; }
  }

  return (
    <div style={{ width:"100%", maxWidth:820, margin:"0 auto" }}>
      <PageHeader title="공지 공유" sub="친구들에게 중요한 내용을 공유해요" action={
        <button onClick={() => setShowForm(!showForm)} style={{ padding:"8px 16px", border:"none", borderRadius:10, background: showForm?"#f1f5f9":"linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm?"#64748b":"#fff", fontSize:13, fontWeight:700, cursor:"pointer", transition:"all .2s" }}>
          {showForm?"✕ 닫기":"+ 작성"}
        </button>
      } />
      {showForm && (
        <div className="card" style={{ padding:20, marginBottom:18, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ marginBottom:10 }}>
            <label style={LBL}>제목</label>
            <input className="input-field" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="예: 내일 체육복 지참" />
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={LBL}>내용</label>
            <textarea className="input-field" value={form.content} onChange={e=>setForm({...form,content:e.target.value})} placeholder="자세한 내용을 써주세요" rows={4} style={{ resize:"none", lineHeight:1.7 }} />
          </div>
          <button className="btn-primary" onClick={add} disabled={saving}>{saving?"등록 중...":"공지 올리기"}</button>
        </div>
      )}
      {notices.length === 0
        ? <EmptyFull icon="📢" text="아직 공지가 없어요" sub="위 버튼으로 친구들에게 알려주세요!" />
        : (
          <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:12 }}>
            {notices.map(n => (
              <div key={n.id} className="card hover-card" style={{ padding:18 }}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", flex:1, lineHeight:1.4, paddingRight:8 }}>{n.title}</div>
                  {n.authorName === user.name && (
                    <button onClick={()=>del(n.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:14, cursor:"pointer", flexShrink:0, lineHeight:1, transition:"color .15s" }}
                      onMouseEnter={e=>e.currentTarget.style.color="#ef4444"} onMouseLeave={e=>e.currentTarget.style.color="#e2e8f0"}>✕</button>
                  )}
                </div>
                <div style={{ fontSize:13, color:"#475569", lineHeight:1.75, marginBottom:10 }}>{n.content}</div>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <div style={{ width:22, height:22, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:10, fontWeight:900, flexShrink:0 }}>{n.authorName[0]}</div>
                  <span style={{ fontSize:11, color:"#94a3b8" }}>{n.authorName}</span>
                  <span style={{ fontSize:11, color:"#e2e8f0", marginLeft:"auto" }}>{fmtDate(n.createdAt)}</span>
                </div>
              </div>
            ))}
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

  useEffect(() => {
    (async () => {
      setLoading(true);
      const data = await fetchWeekMeals();
      setMealMap(data);
      setLoading(false);
    })();
  }, []);

  const todayMeals = mealMap[todayDash] || {};
  const menuDays   = Object.entries(mealMap).sort(([a],[b]) => a.localeCompare(b));
  const mealTypes  = ["조식","중식","석식"];

  if (loading) return (
    <div style={{ textAlign:"center", padding:"60px 20px" }}>
      <div style={{ fontSize:36, animation:"float 1.5s ease-in-out infinite" }}>🍱</div>
      <div style={{ fontSize:13, color:"#94a3b8", marginTop:10 }}>급식 정보 불러오는 중...</div>
    </div>
  );

  return (
    <div style={{ width:"100%", maxWidth:820, margin:"0 auto" }}>
      <PageHeader title="급식 메뉴" sub="세종대성고등학교 이번 주 급식이에요" />
      {Object.keys(todayMeals).length > 0 ? (
        <div style={{ marginBottom:18 }}>
          <GroupLabel>오늘의 급식</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile?"1fr":"repeat(3,1fr)", gap:10 }}>
            {mealTypes.map(type => {
              const meta  = MEAL_META[type];
              const items = todayMeals[type];
              if (!items) return null;
              return (
                <div key={type} style={{ background:`linear-gradient(135deg,${meta.color},${meta.color}bb)`, borderRadius:14, padding:"16px", color:"#fff", boxShadow:`0 6px 20px ${meta.color}44` }}>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,.75)", fontWeight:700, letterSpacing:1.2, marginBottom:7 }}>{meta.icon} {meta.label.toUpperCase()}</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {items.map((item,i) => <span key={i} style={{ background:"rgba(255,255,255,.2)", padding:"3px 8px", borderRadius:20, fontSize:11, fontWeight:600 }}>{item}</span>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding:22, textAlign:"center", color:"#94a3b8", marginBottom:18 }}>오늘은 급식 정보가 없어요 😢</div>
      )}
      <div style={{ display:"flex", gap:7, marginBottom:14 }}>
        {mealTypes.map(type => {
          const meta = MEAL_META[type];
          return (
            <button key={type} onClick={() => setSelMeal(type)} style={{ padding:"6px 14px", border:"none", borderRadius:18, cursor:"pointer", fontSize:12, fontWeight:700, background: selMeal===type?meta.color:"#f1f5f9", color: selMeal===type?"#fff":"#64748b", transition:"all .15s" }}>
              {meta.icon} {type}
            </button>
          );
        })}
      </div>
      {menuDays.length === 0 ? (
        <div className="card" style={{ padding:22, textAlign:"center", color:"#94a3b8" }}>이번 주 급식 정보가 없어요</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns: isDesktop?"1fr 1fr":"1fr", gap:10 }}>
          {menuDays.map(([date, meals]) => {
            const d       = new Date(date);
            const isToday = date === todayDash;
            const items   = meals[selMeal];
            const meta    = MEAL_META[selMeal];
            return (
              <div key={date} className="card hover-card" style={{ padding:14, borderLeft:`3px solid ${isToday?meta.color:"#f0f4ff"}` }}>
                <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:9 }}>
                  <span className="tag" style={{ background:isToday?meta.bg:"#f1f5f9", color:isToday?meta.color:"#64748b" }}>
                    {date.slice(5).replace("-","/")} ({DAY_KR[d.getDay()]})
                  </span>
                  {isToday && <span style={{ fontSize:11, color:meta.color, fontWeight:700 }}>오늘</span>}
                </div>
                {items ? (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {items.map((item,i) => <span key={i} style={{ fontSize:11, padding:"3px 8px", borderRadius:18, background:"#f8faff", color:"#475569", fontWeight:500 }}>{item}</span>)}
                  </div>
                ) : <div style={{ fontSize:12, color:"#cbd5e1" }}>정보 없음</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 반 인원 - 실시간 onSnapshot
// ══════════════════════════════════════════════════════
function MembersPage({ user }) {
  const { isDesktop } = useBreakpoint();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now,     setNow]     = useState(Date.now());

  // 1분마다 now 갱신 → 온라인 상태 자동 재계산
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // 실시간 구독
  useEffect(() => {
    const q    = query(collection(db,"members"), where("classCode","==",user.classCode));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => d.data()).sort((a,b) => a.name.localeCompare(b.name,"ko"));
      setMembers(data);
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [user.classCode]);

  const onlineMembers  = members.filter(m => isOnline(m.lastSeen));
  const offlineMembers = members.filter(m => !isOnline(m.lastSeen));

  const AVATAR_COLORS = [
    "linear-gradient(135deg,#4f8cff,#7c3aed)",
    "linear-gradient(135deg,#10b981,#06b6d4)",
    "linear-gradient(135deg,#f59e0b,#ef4444)",
    "linear-gradient(135deg,#8b5cf6,#ec4899)",
    "linear-gradient(135deg,#3b82f6,#10b981)",
  ];

  function MemberCard({ m, i }) {
    const online = isOnline(m.lastSeen);
    return (
      <div className="card hover-card" style={{ padding:14, textAlign:"center", opacity: online?1:.7 }}>
        <div style={{ position:"relative", width:46, height:46, margin:"0 auto 8px" }}>
          <div style={{ width:46, height:46, borderRadius:"50%", background: AVATAR_COLORS[i % AVATAR_COLORS.length], display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:18 }}>
            {m.name[0]}
          </div>
          <div className={online?"online-dot":"offline-dot"} style={{ position:"absolute", bottom:1, right:1 }} />
        </div>
        <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>
          {m.name}
          {m.name === user.name && <span style={{ fontSize:10, color:"#4f8cff", marginLeft:3 }}>나</span>}
        </div>
        <div style={{ fontSize:10, color: online?"#10b981":"#94a3b8", marginTop:2, fontWeight:600 }}>
          {online ? "🟢 접속 중" : "⚫ 오프라인"}
        </div>
        <div style={{ fontSize:10, color:"#cbd5e1", marginTop:1 }}>{m.grade}학년 {m.cls}반</div>
      </div>
    );
  }

  return (
    <div style={{ width:"100%", maxWidth:720, margin:"0 auto" }}>
      {/* 헤더 */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
        <div>
          <h2 style={{ fontSize:18, fontWeight:900, color:"#1e293b" }}>반 인원</h2>
          <p style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>{user.classCode} 반 · 총 {members.length}명</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <div style={{ padding:"6px 12px", borderRadius:18, background:"#d1fae5", color:"#059669", fontSize:12, fontWeight:800 }}>
            🟢 {onlineMembers.length}명 접속 중
          </div>
          <div style={{ padding:"6px 12px", borderRadius:18, background:"#f1f5f9", color:"#94a3b8", fontSize:12, fontWeight:700 }}>
            전체 {members.length}명
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign:"center", padding:"60px 20px" }}>
          <div style={{ fontSize:36, animation:"float 1.5s ease-in-out infinite" }}>👥</div>
          <div style={{ fontSize:13, color:"#94a3b8", marginTop:10 }}>인원 불러오는 중...</div>
        </div>
      ) : members.length === 0 ? (
        <EmptyFull icon="👥" text="아직 아무도 없어요" sub="친구들에게 반 코드를 공유해요!" />
      ) : (
        <>
          {/* 접속 중 */}
          {onlineMembers.length > 0 && (
            <section style={{ marginBottom:22 }}>
              <GroupLabel>🟢 접속 중 ({onlineMembers.length})</GroupLabel>
              <div style={{ display:"grid", gridTemplateColumns: isDesktop?"repeat(4,1fr)":"repeat(3,1fr)", gap:10 }}>
                {onlineMembers.map((m,i) => <MemberCard key={m.name} m={m} i={i} />)}
              </div>
            </section>
          )}

          {/* 오프라인 */}
          {offlineMembers.length > 0 && (
            <section>
              <GroupLabel faded>오프라인 ({offlineMembers.length})</GroupLabel>
              <div style={{ display:"grid", gridTemplateColumns: isDesktop?"repeat(4,1fr)":"repeat(3,1fr)", gap:10 }}>
                {offlineMembers.map((m,i) => <MemberCard key={m.name} m={m} i={onlineMembers.length+i} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공통
// ══════════════════════════════════════════════════════
function PageHeader({ title, sub, action }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
      <div>
        <h2 style={{ fontSize:18, fontWeight:900, color:"#1e293b" }}>{title}</h2>
        {sub && <p style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function SectionHeader({ title, onMore }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:11 }}>
      <div style={{ fontSize:13, fontWeight:800, color:"#1e293b" }}>{title}</div>
      <button onClick={onMore} style={{ background:"none", border:"none", fontSize:12, color:"#94a3b8", fontWeight:600, cursor:"pointer" }}>더보기 →</button>
    </div>
  );
}

function GroupLabel({ children, faded }) {
  return <div style={{ fontSize:11, fontWeight:700, color: faded?"#cbd5e1":"#94a3b8", letterSpacing:1.5, marginBottom:10 }}>{children}</div>;
}

function EmptyMini({ icon, text }) {
  return <div style={{ textAlign:"center", padding:"20px 0", color:"#cbd5e1" }}><span style={{ fontSize:24 }}>{icon}</span><div style={{ fontSize:12, fontWeight:600, marginTop:6 }}>{text}</div></div>;
}

function EmptyFull({ icon, text, sub }) {
  return (
    <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8" }}>
      <div style={{ fontSize:44, marginBottom:10 }}>{icon}</div>
      <div style={{ fontSize:15, fontWeight:700, color:"#64748b", marginBottom:4 }}>{text}</div>
      {sub && <div style={{ fontSize:12 }}>{sub}</div>}
    </div>
  );
}

const LBL = { display:"block", fontSize:11, fontWeight:700, color:"#64748b", letterSpacing:.5, marginBottom:6 };