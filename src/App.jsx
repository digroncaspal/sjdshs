import { useState, useEffect, useCallback } from "react";
import {
  collection, addDoc, getDocs, deleteDoc,
  doc, query, where, orderBy, serverTimestamp,
} from "firebase/firestore";
import { db } from "./services/firebase";

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

function useBreakpoint() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    function check() { setIsMobile(window.innerWidth < 768); }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return { isMobile };
}

function parseMenu(raw) {
  return raw.replace(/<br\/>/g,"\n").split("\n")
    .map(s => s.replace(/\([\d.,/]+\)/g,"").trim())
    .filter(Boolean);
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

  .card { background:#fff; border-radius:18px; border:1px solid #e8eef8; box-shadow:0 2px 16px rgba(79,140,255,.06); }
  .hover-card { transition:transform .18s,box-shadow .18s; cursor:pointer; }
  .hover-card:hover { transform:translateY(-3px); box-shadow:0 10px 32px rgba(79,140,255,.13); }
  .tag { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border-radius:20px; font-size:11px; font-weight:700; }
  .input-field { width:100%; padding:13px 16px; background:#f8faff; border:1.5px solid #e8eef8; border-radius:12px; font-size:14px; color:#1e293b; transition:border-color .2s,box-shadow .2s; }
  .input-field:focus { border-color:#4f8cff; box-shadow:0 0 0 4px rgba(79,140,255,.1); background:#fff; }
  .btn-primary { padding:13px 24px; border:none; border-radius:12px; background:linear-gradient(135deg,#4f8cff,#7c3aed); color:#fff; font-size:14px; font-weight:700; cursor:pointer; box-shadow:0 4px 18px rgba(79,140,255,.3); transition:transform .15s,box-shadow .15s,opacity .15s; }
  .btn-primary:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(79,140,255,.38); }
  .btn-primary:active { transform:scale(.97); }
  .btn-primary:disabled { opacity:.65; cursor:not-allowed; transform:none; }
  .side-nav-btn { width:100%; padding:11px 14px; border-radius:12px; border:none; display:flex; align-items:center; gap:10px; font-size:14px; font-weight:500; cursor:pointer; transition:all .15s; text-align:left; margin-bottom:3px; background:transparent; color:#64748b; }
  .side-nav-btn.active { background:#eff6ff; color:#1d4ed8; font-weight:700; }
  .side-nav-btn:hover:not(.active) { background:#f8faff; color:#1e293b; }
  .bottom-tab { display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 0 6px; border:none; background:#fff; cursor:pointer; transition:background .15s; }
  .bottom-tab.active { background:#eff6ff; }
  .bottom-tab:hover { background:#f8faff; }

  /* 달력 - 7열 균일 고정 */
  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 3px;
    width: 100%;
    table-layout: fixed;
  }
  .cal-cell {
    width: 100%;
    min-height: 72px;
    padding: 5px 4px;
    border-radius: 8px;
    border: 1px solid #f0f4ff;
    background: #fafbff;
    transition: background .15s;
    cursor: pointer;
    overflow: hidden;
  }
  .cal-cell:hover { background: #eff6ff; }
  .cal-cell.today { border: 2px solid #4f8cff !important; background: #eff6ff; }
  .cal-cell.selected { border: 2px solid #4f8cff !important; background: #eff6ff; }
  .cal-cell.empty {
    background: transparent !important;
    border-color: transparent !important;
    cursor: default;
  }
  .cal-cell.weekend-cell {
    background: #fafafa;
    border-color: #f5f5f5;
  }
  .cal-cell.weekend-cell:hover { background: #f5f5f5; }

  /* 로그인 select 스타일 */
  .login-select {
    width: 100%;
    padding: 13px 16px;
    background: rgba(255,255,255,0.15) !important;
    border: 1.5px solid rgba(255,255,255,0.25);
    border-radius: 12px;
    color: #f1f5f9 !important;
    font-size: 14px;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  .login-select option {
    background: #1e293b;
    color: #f1f5f9;
  }
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

  function submit() {
    if (!name.trim())           { setErr("이름을 입력해주세요"); return; }
    if (code.trim().length < 4) { setErr("반 코드는 4자 이상이에요"); return; }
    setBusy(true);
    setTimeout(() => onLogin({ name:name.trim(), classCode:code.trim().toUpperCase(), grade, cls }), 350);
  }

  return (
    <div style={{ width:"100%", minHeight:"100dvh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0a0f1e", padding:24, position:"relative", overflow:"hidden" }}>
      {[[220,"#4f8cff","12%","8%",3.8],[160,"#7c3aed","78%","72%",4.5],[260,"#06b6d4","68%","12%",5.2],[110,"#f59e0b","22%","78%",3.2]].map(([sz,cl,top,left,dur],i) => (
        <div key={i} style={{ position:"absolute", width:sz, height:sz, borderRadius:"50%", background:cl, opacity:.07, top, left, filter:"blur(70px)", animation:`pulse ${dur}s ease-in-out infinite`, animationDelay:`${i*.6}s`, pointerEvents:"none" }} />
      ))}
      <div style={{ width:"100%", maxWidth:420, position:"relative", zIndex:1, animation:"fadeUp .5s ease" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontSize:56, display:"inline-block", marginBottom:12, animation:"float 3.5s ease-in-out infinite" }}>🏫</div>
          <h1 style={{ fontSize:28, fontWeight:900, color:"#fff", letterSpacing:-1, lineHeight:1.15 }}>
            세종대성<br/>
            <span style={{ background:"linear-gradient(90deg,#60a5fa,#a78bfa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>클래스</span>
          </h1>
          <p style={{ color:"#475569", fontSize:13, marginTop:8 }}>우리 반 전용 일정 · 공지 · 급식 · 학사일정</p>
        </div>
        <div style={{ background:"rgba(255,255,255,.05)", backdropFilter:"blur(24px)", border:"1px solid rgba(255,255,255,.1)", borderRadius:24, padding:"28px 24px" }}>

          {/* 이름 */}
          <div style={{ marginBottom:14 }}>
            <label style={LOGIN_LBL}>이름</label>
            <input value={name} placeholder="홍길동"
              onChange={e=>{setName(e.target.value);setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&submit()}
              style={{ width:"100%", padding:"13px 16px", background:"rgba(255,255,255,.07)", border:"1.5px solid rgba(255,255,255,.13)", borderRadius:12, color:"#f1f5f9", fontSize:15 }} />
          </div>

          {/* 학년 / 반 - 커스텀 select */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
            <div>
              <label style={LOGIN_LBL}>학년</label>
              <div style={{ position:"relative" }}>
                <select value={grade} onChange={e=>setGrade(e.target.value)} className="login-select">
                  {["1","2","3"].map(g=><option key={g} value={g}>{g}학년</option>)}
                </select>
                <div style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"rgba(255,255,255,.6)", fontSize:12 }}>▾</div>
              </div>
            </div>
            <div>
              <label style={LOGIN_LBL}>반 (1~10반)</label>
              <div style={{ position:"relative" }}>
                <select value={cls} onChange={e=>setCls(e.target.value)} className="login-select">
                  {Array.from({length:10},(_,i)=>i+1).map(c=>(
                    <option key={c} value={String(c)}>{c}반</option>
                  ))}
                </select>
                <div style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"rgba(255,255,255,.6)", fontSize:12 }}>▾</div>
              </div>
            </div>
          </div>

          {/* 반 코드 */}
          <div style={{ marginBottom:8 }}>
            <label style={LOGIN_LBL}>반 코드</label>
            <input value={code} placeholder="예: AB12 (4자 이상)"
              onChange={e=>{setCode(e.target.value.toUpperCase());setErr("");}}
              onKeyDown={e=>e.key==="Enter"&&submit()}
              style={{ width:"100%", padding:"13px 16px", background:"rgba(255,255,255,.07)", border:"1.5px solid rgba(255,255,255,.13)", borderRadius:12, color:"#f1f5f9", fontSize:15, letterSpacing:2, fontWeight:700 }} />
          </div>

          {err && <div style={{ fontSize:12, color:"#fca5a5", background:"rgba(239,68,68,.12)", borderRadius:10, padding:"9px 13px", marginBottom:12 }}>⚠️ {err}</div>}

          <button className="btn-primary" onClick={submit} disabled={busy} style={{ width:"100%", marginTop:4, padding:"14px", fontSize:15, fontWeight:800 }}>
            {busy ? "입장 중..." : "입장하기 →"}
          </button>
          <p style={{ textAlign:"center", fontSize:11, color:"#475569", marginTop:12, lineHeight:1.8 }}>
            💡 같은 코드를 쓰면 같은 반으로 묶여요<br/>
            <span style={{ color:"#60a5fa", fontWeight:700 }}>DEMO</span> 코드로 체험해볼 수 있어요
          </p>
        </div>
      </div>
    </div>
  );
}
const LOGIN_LBL = { display:"block", fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.6)", letterSpacing:1.2, marginBottom:7 };

// ══════════════════════════════════════════════════════
// 메인 앱
// ══════════════════════════════════════════════════════
function MainApp({ user, page, setPage, onLogout }) {
  const { isMobile } = useBreakpoint();
  const [schedules, setSchedules] = useState([]);
  const [notices,   setNotices]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [toast,     setToast]     = useState(null);

  const showToast = useCallback((msg, type="info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  }, []);

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
      } catch(e) {
        console.error(e);
        showToast("❌ 데이터 로드 실패","error");
      }
      setLoading(false);
    })();
  }, [user.classCode]);

  const todayStr = getTodayDash();
  // 주말 제외한 일정만 홈에 표시
  const upcoming = schedules
    .filter(s => s.date >= todayStr && !isWeekend(s.date))
    .sort((a,b) => a.date.localeCompare(b.date));
  const todaySch = schedules.filter(s => s.date === todayStr && !isWeekend(s.date));

  const NAV = [
    { id:"home",     icon:"🏠", label:"홈" },
    { id:"schedule", icon:"📅", label:"일정" },
    { id:"academic", icon:"🗓", label:"학사일정" },
    { id:"notice",   icon:"📢", label:"공지" },
    { id:"lunch",    icon:"🍱", label:"급식" },
  ];

  const pages = {
    home:     <HomePage     user={user} schedules={schedules} notices={notices} upcoming={upcoming} todaySch={todaySch} setPage={setPage} loading={loading} />,
    schedule: <SchedulePage user={user} schedules={schedules} setSchedules={setSchedules} showToast={showToast} />,
    academic: <AcademicPage />,
    notice:   <NoticePage   user={user} notices={notices} setNotices={setNotices} showToast={showToast} />,
    lunch:    <LunchPage />,
  };

  return (
    <div style={{ width:"100%", height:"100vh", display:"flex", background:"#f0f4ff", overflow:"hidden" }}>
      {toast && (
        <div style={{ position:"fixed", bottom: isMobile ? 88 : 24, left:"50%", transform:"translateX(-50%)", background: toast.type==="error" ? "#ef4444" : "#1e293b", color:"#fff", padding:"11px 22px", borderRadius:30, fontSize:13, fontWeight:600, zIndex:9999, whiteSpace:"nowrap", boxShadow:"0 8px 28px rgba(0,0,0,.22)", animation:"toastIn .25s ease" }}>
          {toast.msg}
        </div>
      )}

      {!isMobile && (
        <aside style={{ width:240, height:"100vh", background:"#fff", borderRight:"1px solid #e8eef8", display:"flex", flexDirection:"column", boxShadow:"2px 0 20px rgba(79,140,255,.06)", flexShrink:0, overflow:"hidden" }}>
          <div style={{ padding:"24px 20px 16px", borderBottom:"1px solid #f0f4ff" }}>
            <div style={{ fontSize:28, marginBottom:8 }}>🏫</div>
            <div style={{ fontSize:15, fontWeight:900, color:"#1e293b", letterSpacing:-.5 }}>세종대성 클래스</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>{user.classCode} · {user.grade}학년 {user.cls}반</div>
          </div>
          <nav style={{ flex:1, padding:"12px", overflowY:"auto" }}>
            {NAV.map(n => (
              <button key={n.id} className={`side-nav-btn${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:18 }}>{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
          <div style={{ padding:"14px", borderTop:"1px solid #f0f4ff" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
              <div style={{ width:36, height:36, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:14, flexShrink:0 }}>{user.name[0]}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{user.grade}학년 {user.cls}반</div>
              </div>
            </div>
            <button onClick={onLogout} style={{ width:"100%", padding:"8px", borderRadius:10, border:"1px solid #e8eef8", background:"#f8faff", color:"#94a3b8", fontSize:12, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e=>{e.currentTarget.style.background="#fff1f1";e.currentTarget.style.color="#ef4444";e.currentTarget.style.borderColor="#fecaca";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#f8faff";e.currentTarget.style.color="#94a3b8";e.currentTarget.style.borderColor="#e8eef8";}}>
              로그아웃
            </button>
          </div>
        </aside>
      )}

      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
        {isMobile && (
          <header style={{ background:"linear-gradient(135deg,#1d4ed8,#4f46e5)", padding:"12px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:"0 4px 20px rgba(29,78,216,.28)", flexShrink:0 }}>
            <div>
              <div style={{ fontSize:10, color:"rgba(255,255,255,.6)", letterSpacing:2, fontWeight:700 }}>{user.grade}학년 {user.cls}반 · {user.classCode}</div>
              <div style={{ fontSize:15, fontWeight:800, color:"#fff" }}>안녕하세요, {user.name}님 👋</div>
            </div>
            <button onClick={onLogout} style={{ background:"rgba(255,255,255,.15)", border:"none", padding:"6px 12px", borderRadius:20, color:"rgba(255,255,255,.9)", fontSize:12, fontWeight:600, cursor:"pointer" }}>나가기</button>
          </header>
        )}
        {!isMobile && (
          <header style={{ background:"#fff", borderBottom:"1px solid #e8eef8", padding:"14px 32px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
            <div>
              <h2 style={{ fontSize:17, fontWeight:900, color:"#1e293b" }}>
                {{ home:"🏠 홈", schedule:"📅 일정 관리", academic:"🗓 학사일정", notice:"📢 공지 공유", lunch:"🍱 급식 메뉴" }[page]}
              </h2>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>
                {new Date().toLocaleDateString("ko-KR",{ year:"numeric", month:"long", day:"numeric", weekday:"long" })}
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:34, height:34, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:13 }}>{user.name[0]}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{user.grade}학년 {user.cls}반</div>
              </div>
            </div>
          </header>
        )}

        <main style={{ flex:1, overflowY:"auto", padding: isMobile ? "18px 16px" : "24px 32px", paddingBottom: isMobile ? 80 : 28 }}>
          {loading
            ? <div style={{ textAlign:"center", padding:"80px 20px" }}><div style={{ fontSize:40, animation:"float 1.5s ease-in-out infinite" }}>⏳</div><div style={{ fontSize:14, color:"#94a3b8", marginTop:14, fontWeight:600 }}>불러오는 중...</div></div>
            : <div key={page} style={{ animation:"slideUp .3s ease" }}>{pages[page]}</div>
          }
        </main>

        {isMobile && (
          <nav style={{ position:"fixed", bottom:0, left:0, right:0, background:"#fff", borderTop:"1px solid #e8eef8", display:"grid", gridTemplateColumns:"repeat(5,1fr)", boxShadow:"0 -4px 20px rgba(0,0,0,.07)", zIndex:100 }}>
            {NAV.map(n => (
              <button key={n.id} className={`bottom-tab${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:20 }}>{n.icon}</span>
                <span style={{ fontSize: n.label.length > 3 ? 8 : 9, fontWeight: page===n.id ? 800 : 500, color: page===n.id ? "#1d4ed8" : "#94a3b8" }}>{n.label}</span>
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
  const { isMobile } = useBreakpoint();
  const now      = new Date();
  const dayNames = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];
  const urgentSchedules = upcoming.filter(s => getDday(s.date).urgent).slice(0,4);

  return (
    <div style={{ width:"100%" }}>
      <div style={{ background:"linear-gradient(135deg,#1d4ed8,#4f46e5 55%,#7c3aed)", borderRadius:20, padding: isMobile ? "20px" : "26px 30px", marginBottom:20, color:"#fff", boxShadow:"0 12px 40px rgba(29,78,216,.28)", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-30, top:-30, width:180, height:180, borderRadius:"50%", background:"rgba(255,255,255,.07)", pointerEvents:"none" }} />
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.6)", fontWeight:700, letterSpacing:2, marginBottom:4 }}>TODAY</div>
          <div style={{ fontSize: isMobile ? 20 : 24, fontWeight:900, letterSpacing:-.5, marginBottom: todaySch.length ? 12 : 0 }}>
            {now.getMonth()+1}월 {now.getDate()}일 {dayNames[now.getDay()]}
          </div>
          {todaySch.length > 0
            ? todaySch.map(s => {
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ background:"rgba(255,255,255,.15)", backdropFilter:"blur(10px)", borderRadius:10, padding:"9px 13px", display:"flex", alignItems:"center", gap:10, marginTop:7 }}>
                  <span style={{ fontSize:15 }}>{meta.icon}</span>
                  <span style={{ fontSize:13, fontWeight:600, flex:1 }}>{s.title}</span>
                  <span className="tag" style={{ background:"rgba(255,255,255,.2)", color:"#fff" }}>{s.type}</span>
                </div>
              );
            })
            : <div style={{ fontSize:12, color:"rgba(255,255,255,.5)", marginTop:5 }}>오늘 등록된 일정이 없어요 😌</div>
          }
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:16 }}>
        <div className="card" style={{ padding:20 }}>
          <SectionHeader title="⏳ 다가오는 일정" onMore={() => setPage("schedule")} />
          {upcoming.length === 0
            ? <EmptyMini icon="📅" text="다가오는 평일 일정이 없어요" />
            : upcoming.slice(0,4).map(s => {
              const dd   = getDday(s.date);
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:11, padding:"9px 0", borderBottom:"1px solid #f8faff" }}>
                  <div style={{ width:36, height:36, borderRadius:9, background:meta.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0 }}>{meta.icon}</div>
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

        <div className="card" style={{ padding:20 }}>
          <SectionHeader title="📢 최근 공지" onMore={() => setPage("notice")} />
          {notices.length === 0
            ? <EmptyMini icon="📢" text="공지가 없어요" />
            : notices.slice(0,3).map(n => (
              <div key={n.id} style={{ padding:"9px 0", borderBottom:"1px solid #f8faff" }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b", marginBottom:2 }}>{n.title}</div>
                <div style={{ fontSize:12, color:"#64748b", lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{n.content}</div>
                <div style={{ fontSize:10, color:"#cbd5e1", marginTop:4 }}>{n.authorName}</div>
              </div>
            ))
          }
        </div>

        {urgentSchedules.map((s,i) => {
          const dd   = getDday(s.date);
          const meta = TYPE_META[s.type] || TYPE_META["기타"];
          return (
            <div key={s.id} className="card hover-card" onClick={() => setPage("schedule")} style={{ padding:20, borderLeft:`4px solid ${meta.color}`, animation:`popIn .35s ease ${i*.08}s both` }}>
              <span className="tag" style={{ background:meta.bg, color:meta.color, marginBottom:10 }}>{meta.icon} {s.type}</span>
              <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", marginBottom:3 }}>{s.title}</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:12 }}>{s.date}</div>
              <div style={{ fontSize:32, fontWeight:900, color:dd.color, letterSpacing:-1 }}>{dd.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 일정 (주말 제외 필터 옵션)
// ══════════════════════════════════════════════════════
function SchedulePage({ user, schedules, setSchedules, showToast }) {
  const { isMobile } = useBreakpoint();
  const [showForm,    setShowForm]    = useState(false);
  const [hideWeekend, setHideWeekend] = useState(true);
  const [form,    setForm]   = useState({ title:"", date:"", type:"수행평가" });
  const [saving,  setSaving] = useState(false);
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
    <div style={{ width:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <div>
          <h2 style={{ fontSize:19, fontWeight:900, color:"#1e293b" }}>일정 관리</h2>
          <p style={{ fontSize:12, color:"#94a3b8", marginTop:3 }}>수행평가·시험·행사를 등록해요</p>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* 주말 제외 토글 */}
          <button onClick={() => setHideWeekend(!hideWeekend)} style={{
            padding:"7px 13px", border:"none", borderRadius:20, cursor:"pointer", fontSize:11, fontWeight:700,
            background: hideWeekend ? "#eff6ff" : "#f1f5f9",
            color: hideWeekend ? "#1d4ed8" : "#94a3b8",
            transition:"all .15s",
          }}>
            {hideWeekend ? "📅 주말 제외" : "📅 주말 포함"}
          </button>
          <button onClick={() => setShowForm(!showForm)} style={{ padding:"9px 18px", border:"none", borderRadius:12, background: showForm ? "#f1f5f9" : "linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm ? "#64748b" : "#fff", fontSize:13, fontWeight:700, cursor:"pointer", transition:"all .2s" }}>
            {showForm ? "✕ 닫기" : "+ 일정 추가"}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="card" style={{ padding:22, marginBottom:20, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr 1fr", gap:12, marginBottom:14 }}>
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
        <section style={{ marginBottom:24 }}>
          <GroupLabel>다가오는 일정 ({upcoming.length})</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:11 }}>
            {upcoming.map(s=><SchedCard key={s.id} s={s} user={user} onDel={del} />)}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <GroupLabel faded>지난 일정</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:9, opacity:.5 }}>
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
    <div className="card hover-card" style={{ padding:16, borderLeft:`3px solid ${dd.urgent&&!past ? meta.color : "#f0f4ff"}` }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
        <span className="tag" style={{ background:meta.bg, color:meta.color }}>{meta.icon} {s.type}</span>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {!past && <span style={{ fontSize:12, fontWeight:900, color:dd.color }}>{dd.label}</span>}
          {s.authorName === user.name && (
            <button onClick={()=>onDel(s.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:14, cursor:"pointer", padding:2, lineHeight:1, transition:"color .15s" }}
              onMouseEnter={e=>e.currentTarget.style.color="#ef4444"} onMouseLeave={e=>e.currentTarget.style.color="#e2e8f0"}>✕</button>
          )}
        </div>
      </div>
      <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", marginBottom:3 }}>{s.title}</div>
      <div style={{ fontSize:11, color:"#94a3b8" }}>{s.date.slice(5).replace("-","/")} · {DAY_KR[new Date(s.date).getDay()]} · {s.authorName}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 학사일정 달력
// ══════════════════════════════════════════════════════
function AcademicPage() {
  const { isMobile } = useBreakpoint();
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
  // 42칸 고정
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
      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 260px", gap:20 }}>

        {/* 달력 */}
        <div className="card" style={{ padding:20 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
            <button onClick={prevMonth} style={{ background:"#f0f4ff", border:"none", width:34, height:34, borderRadius:8, cursor:"pointer", fontSize:18, color:"#4f8cff", display:"flex", alignItems:"center", justifyContent:"center" }}>‹</button>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:900, color:"#1e293b" }}>{year}년 {MONTH_KR[month-1]}</div>
              {loading && <div style={{ fontSize:10, color:"#94a3b8", marginTop:1 }}>불러오는 중...</div>}
            </div>
            <button onClick={nextMonth} style={{ background:"#f0f4ff", border:"none", width:34, height:34, borderRadius:8, cursor:"pointer", fontSize:18, color:"#4f8cff", display:"flex", alignItems:"center", justifyContent:"center" }}>›</button>
          </div>

          {/* 요일 헤더 - 7열 균일 */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(7, minmax(0, 1fr))", marginBottom:4 }}>
            {DAY_KR.map((d,i) => (
              <div key={d} style={{
                textAlign:"center", fontSize:11, fontWeight:700, padding:"4px 0",
                color: i===0 ? "#ef4444" : i===6 ? "#3b82f6" : "#94a3b8",
              }}>{d}</div>
            ))}
          </div>

          {/* 날짜 그리드 - 42칸 고정, 7열 균일 */}
          <div className="cal-grid">
            {cells.map((day, idx) => {
              const colIdx    = idx % 7;
              const isSun     = colIdx === 0;
              const isSat     = colIdx === 6;
              const isWeekendCell = isSun || isSat;

              if (!day) return <div key={idx} className="cal-cell empty" />;

              const dash    = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
              const dayEvts = eventsForDay(day);
              const isToday = dash === todayDash;
              const isSel   = selected === day;

              return (
                <div
                  key={idx}
                  className={`cal-cell${isWeekendCell?" weekend-cell":""}${isToday?" today":""}${isSel?" selected":""}`}
                  onClick={() => setSelected(isSel ? null : day)}
                >
                  <div style={{
                    fontSize:12, fontWeight: isToday ? 800 : 400,
                    textAlign:"right", marginBottom:2,
                    color: isToday ? "#4f8cff" : isSun ? "#ef4444" : isSat ? "#3b82f6" : "#64748b",
                  }}>
                    {day}
                  </div>
                  {dayEvts.slice(0,2).map((e,i) => (
                    <div key={i} style={{
                      fontSize:9, padding:"2px 3px", borderRadius:3, marginBottom:1,
                      background: isWeekendCell ? "#e0e7ff" : "#dbeafe",
                      color: isWeekendCell ? "#6366f1" : "#1d4ed8",
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontWeight:600,
                    }}>
                      {e.title}
                    </div>
                  ))}
                  {dayEvts.length > 2 && (
                    <div style={{ fontSize:9, color:"#94a3b8", textAlign:"right" }}>+{dayEvts.length-2}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 사이드 패널 */}
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {selected && (
            <div className="card" style={{ padding:18, animation:"popIn .2s ease", borderTop:"3px solid #4f8cff" }}>
              <div style={{ fontSize:13, fontWeight:800, color:"#1d4ed8", marginBottom:10 }}>
                {month}월 {selected}일 ({DAY_KR[new Date(year,month-1,selected).getDay()]})
              </div>
              {selectedEvents.length === 0
                ? <div style={{ fontSize:12, color:"#cbd5e1", textAlign:"center", padding:"12px 0" }}>학사일정 없음</div>
                : selectedEvents.map((e,i) => (
                  <div key={i} style={{ padding:"8px 10px", borderRadius:10, background:"#eff6ff", marginBottom:6 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{e.title}</div>
                  </div>
                ))
              }
            </div>
          )}

          <div className="card" style={{ padding:18, flex:1, overflowY:"auto", maxHeight: isMobile ? "none" : 480 }}>
            <div style={{ fontSize:13, fontWeight:800, color:"#1e293b", marginBottom:12 }}>{MONTH_KR[month-1]} 학사일정</div>
            {loading ? (
              <div style={{ fontSize:12, color:"#94a3b8", textAlign:"center", padding:"16px 0" }}>불러오는 중...</div>
            ) : events.length === 0 ? (
              <div style={{ fontSize:12, color:"#cbd5e1", textAlign:"center", padding:"16px 0" }}>이달 학사일정 없음</div>
            ) : (
              events.map((e,i) => {
                const d  = new Date(e.date);
                const dd = getDday(e.date);
                return (
                  <div key={i}
                    onClick={() => setSelected(d.getDate())}
                    style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 6px", borderRadius:8, marginBottom:2, cursor:"pointer", background: selected===d.getDate() ? "#eff6ff" : "transparent", transition:"background .15s" }}>
                    <div style={{ minWidth:32, textAlign:"center", flexShrink:0 }}>
                      <div style={{ fontSize:15, fontWeight:900, color: d.getDay()===0?"#ef4444": d.getDay()===6?"#3b82f6":"#4f8cff", lineHeight:1 }}>{d.getDate()}</div>
                      <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600 }}>{DAY_KR[d.getDay()]}</div>
                    </div>
                    <div style={{ flex:1, fontSize:12, fontWeight:600, color:"#1e293b", lineHeight:1.4 }}>{e.title}</div>
                    {!dd.past && <span style={{ fontSize:10, fontWeight:800, color:dd.color, flexShrink:0 }}>{dd.label}</span>}
                  </div>
                );
              })
            )}
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
  const { isMobile } = useBreakpoint();
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
    try { return (val.toDate ? val.toDate() : new Date(val)).toLocaleDateString("ko-KR",{month:"short",day:"numeric"}); } catch { return ""; }
  }

  return (
    <div style={{ width:"100%" }}>
      <PageHeader title="공지 공유" sub="친구들에게 중요한 내용을 공유해요" action={
        <button onClick={() => setShowForm(!showForm)} style={{ padding:"9px 18px", border:"none", borderRadius:12, background: showForm ? "#f1f5f9" : "linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm ? "#64748b" : "#fff", fontSize:13, fontWeight:700, cursor:"pointer", transition:"all .2s" }}>
          {showForm ? "✕ 닫기" : "+ 공지 작성"}
        </button>
      } />

      {showForm && (
        <div className="card" style={{ padding:22, marginBottom:20, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ marginBottom:12 }}>
            <label style={LBL}>제목</label>
            <input className="input-field" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="예: 내일 체육복 지참" />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={LBL}>내용</label>
            <textarea className="input-field" value={form.content} onChange={e=>setForm({...form,content:e.target.value})} placeholder="자세한 내용을 써주세요" rows={4} style={{ resize:"none", lineHeight:1.7 }} />
          </div>
          <button className="btn-primary" onClick={add} disabled={saving}>{saving?"등록 중...":"공지 올리기"}</button>
        </div>
      )}

      {notices.length === 0
        ? <EmptyFull icon="📢" text="아직 공지가 없어요" sub="위 버튼으로 친구들에게 알려주세요!" />
        : (
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:13 }}>
            {notices.map(n => (
              <div key={n.id} className="card hover-card" style={{ padding:20 }}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:9 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", flex:1, lineHeight:1.4, paddingRight:8 }}>{n.title}</div>
                  {n.authorName === user.name && (
                    <button onClick={()=>del(n.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:15, cursor:"pointer", flexShrink:0, lineHeight:1, transition:"color .15s" }}
                      onMouseEnter={e=>e.currentTarget.style.color="#ef4444"} onMouseLeave={e=>e.currentTarget.style.color="#e2e8f0"}>✕</button>
                  )}
                </div>
                <div style={{ fontSize:13, color:"#475569", lineHeight:1.75, marginBottom:12 }}>{n.content}</div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:24, height:24, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:10, fontWeight:900, flexShrink:0 }}>{n.authorName[0]}</div>
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
  const { isMobile } = useBreakpoint();
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
      <div style={{ fontSize:13, color:"#94a3b8", marginTop:12 }}>급식 정보 불러오는 중...</div>
    </div>
  );

  return (
    <div style={{ width:"100%" }}>
      <PageHeader title="급식 메뉴" sub="세종대성고등학교 이번 주 급식이에요" />

      {Object.keys(todayMeals).length > 0 ? (
        <div style={{ marginBottom:20 }}>
          <GroupLabel>오늘의 급식</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3,1fr)", gap:12 }}>
            {mealTypes.map(type => {
              const meta  = MEAL_META[type];
              const items = todayMeals[type];
              if (!items) return null;
              return (
                <div key={type} style={{ background:`linear-gradient(135deg,${meta.color},${meta.color}bb)`, borderRadius:16, padding:"18px", color:"#fff", boxShadow:`0 8px 24px ${meta.color}44` }}>
                  <div style={{ fontSize:11, color:"rgba(255,255,255,.8)", fontWeight:700, letterSpacing:1.5, marginBottom:8 }}>
                    {meta.icon} {meta.label.toUpperCase()}
                  </div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                    {items.map((item,i) => (
                      <span key={i} style={{ background:"rgba(255,255,255,.22)", padding:"4px 9px", borderRadius:20, fontSize:12, fontWeight:600 }}>{item}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding:24, textAlign:"center", color:"#94a3b8", marginBottom:20 }}>오늘은 급식 정보가 없어요 😢</div>
      )}

      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {mealTypes.map(type => {
          const meta = MEAL_META[type];
          return (
            <button key={type} onClick={() => setSelMeal(type)} style={{
              padding:"7px 16px", border:"none", borderRadius:20, cursor:"pointer", fontSize:12, fontWeight:700,
              background: selMeal===type ? meta.color : "#f1f5f9",
              color: selMeal===type ? "#fff" : "#64748b",
              transition:"all .15s",
            }}>
              {meta.icon} {type}
            </button>
          );
        })}
      </div>

      {menuDays.length === 0 ? (
        <div className="card" style={{ padding:24, textAlign:"center", color:"#94a3b8" }}>이번 주 급식 정보가 없어요</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:11 }}>
          {menuDays.map(([date, meals]) => {
            const d       = new Date(date);
            const isToday = date === todayDash;
            const items   = meals[selMeal];
            const meta    = MEAL_META[selMeal];
            return (
              <div key={date} className="card hover-card" style={{ padding:16, borderLeft:`3px solid ${isToday ? meta.color : "#f0f4ff"}` }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span className="tag" style={{ background: isToday ? meta.bg : "#f1f5f9", color: isToday ? meta.color : "#64748b" }}>
                    {date.slice(5).replace("-","/")} ({DAY_KR[d.getDay()]})
                  </span>
                  {isToday && <span style={{ fontSize:11, color:meta.color, fontWeight:700 }}>오늘</span>}
                </div>
                {items ? (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                    {items.map((item,i) => (
                      <span key={i} style={{ fontSize:12, padding:"4px 9px", borderRadius:20, background:"#f8faff", color:"#475569", fontWeight:500 }}>{item}</span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize:12, color:"#cbd5e1" }}>정보 없음</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공통
// ══════════════════════════════════════════════════════
function PageHeader({ title, sub, action }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
      <div>
        <h2 style={{ fontSize:19, fontWeight:900, color:"#1e293b" }}>{title}</h2>
        {sub && <p style={{ fontSize:12, color:"#94a3b8", marginTop:3 }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function SectionHeader({ title, onMore }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:13 }}>
      <div style={{ fontSize:13, fontWeight:800, color:"#1e293b" }}>{title}</div>
      <button onClick={onMore} style={{ background:"none", border:"none", fontSize:12, color:"#94a3b8", fontWeight:600, cursor:"pointer" }}>더보기 →</button>
    </div>
  );
}

function GroupLabel({ children, faded }) {
  return <div style={{ fontSize:11, fontWeight:700, color: faded?"#cbd5e1":"#94a3b8", letterSpacing:1.5, marginBottom:11 }}>{children}</div>;
}

function EmptyMini({ icon, text }) {
  return <div style={{ textAlign:"center", padding:"22px 0", color:"#cbd5e1" }}><span style={{ fontSize:26 }}>{icon}</span><div style={{ fontSize:12, fontWeight:600, marginTop:7 }}>{text}</div></div>;
}

function EmptyFull({ icon, text, sub }) {
  return (
    <div style={{ textAlign:"center", padding:"64px 20px", color:"#94a3b8" }}>
      <div style={{ fontSize:46, marginBottom:12 }}>{icon}</div>
      <div style={{ fontSize:15, fontWeight:700, color:"#64748b", marginBottom:5 }}>{text}</div>
      {sub && <div style={{ fontSize:12 }}>{sub}</div>}
    </div>
  );
}

const LBL = { display:"block", fontSize:11, fontWeight:700, color:"#64748b", letterSpacing:.5, marginBottom:7 };