import { useState, useEffect, useCallback } from "react";
import {
  collection, addDoc, getDocs, deleteDoc,
  doc, query, where, orderBy, serverTimestamp,
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

const SAMPLE_LUNCH = {
  "2026-03-22": ["잡곡밥", "된장찌개", "제육볶음", "깍두기", "우유"],
  "2026-03-23": ["현미밥", "김치찌개", "고등어구이", "시금치나물", "요구르트"],
  "2026-03-24": ["쌀밥", "부대찌개", "닭강정", "콩나물무침", "사과"],
  "2026-03-25": ["보리밥", "순두부찌개", "불고기", "무생채", "우유"],
  "2026-03-26": ["흑미밥", "미역국", "돈까스", "단무지", "우유"],
};

const storage = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

function getTodayStr() { return new Date().toISOString().slice(0, 10); }
function getDday(dateStr) {
  const diff = Math.ceil((new Date(dateStr) - new Date(getTodayStr())) / 86400000);
  if (diff === 0) return { label: "D-Day", color: "#ef4444", urgent: true };
  if (diff > 0 && diff <= 7) return { label: `D-${diff}`, color: "#f59e0b", urgent: true };
  if (diff > 0) return { label: `D-${diff}`, color: "#94a3b8", urgent: false };
  return { label: `D+${Math.abs(diff)}`, color: "#cbd5e1", urgent: false, past: true };
}

function useBreakpoint() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return { isMobile: w < 768, isTablet: w < 1024 };
}

// ══════════════════════════════════════════════════════
// CSS 글로벌
// ══════════════════════════════════════════════════════
const GLOBAL_CSS = `
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f0f4ff; font-family: 'Pretendard', 'Noto Sans KR', sans-serif; }
  input, textarea, select, button { font-family: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; }
  ::placeholder { color: #94a3b8; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-thumb { background: #dbeafe; border-radius: 4px; }

  @keyframes fadeUp  { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
  @keyframes popIn   { 0%{opacity:0;transform:scale(.94)} 100%{opacity:1;transform:scale(1)} }
  @keyframes float   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
  @keyframes pulse   { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:.85;transform:scale(1.04)} }
  @keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(12px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  @keyframes spin    { to{transform:rotate(360deg)} }

  .card {
    background: #fff;
    border-radius: 18px;
    border: 1px solid #e8eef8;
    box-shadow: 0 2px 16px rgba(79,140,255,.06);
  }
  .hover-card {
    transition: transform .18s, box-shadow .18s;
    cursor: pointer;
  }
  .hover-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 10px 32px rgba(79,140,255,.13);
  }
  .tag {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 20px;
    font-size: 11px; font-weight: 700;
  }
  .input-field {
    width: 100%; padding: 13px 16px;
    background: #f8faff;
    border: 1.5px solid #e8eef8;
    border-radius: 12px;
    font-size: 14px; color: #1e293b;
    transition: border-color .2s, box-shadow .2s;
  }
  .input-field:focus {
    border-color: #4f8cff;
    box-shadow: 0 0 0 4px rgba(79,140,255,.1);
    background: #fff;
  }
  .btn-primary {
    padding: 13px 24px; border: none; border-radius: 12px;
    background: linear-gradient(135deg, #4f8cff, #7c3aed);
    color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 18px rgba(79,140,255,.3);
    transition: transform .15s, box-shadow .15s, opacity .15s;
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(79,140,255,.38); }
  .btn-primary:active { transform: scale(.97); }
  .btn-primary:disabled { opacity: .65; cursor: not-allowed; transform: none; }
  .side-nav-btn {
    width: 100%; padding: 11px 14px; border-radius: 12px; border: none;
    display: flex; align-items: center; gap: 10px;
    font-size: 14px; font-weight: 500; cursor: pointer;
    transition: all .15s; text-align: left; margin-bottom: 3px;
    background: transparent; color: #64748b;
  }
  .side-nav-btn.active { background: #eff6ff; color: #1d4ed8; font-weight: 700; }
  .side-nav-btn:hover:not(.active) { background: #f8faff; color: #1e293b; }
  .bottom-tab { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 10px 0 8px; border: none; background: #fff; cursor: pointer; transition: background .15s; }
  .bottom-tab.active { background: #eff6ff; }
  .bottom-tab:hover { background: #f8faff; }
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
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err,  setErr]  = useState("");
  const [busy, setBusy] = useState(false);

  function submit() {
    if (!name.trim())           { setErr("이름을 입력해주세요"); return; }
    if (code.trim().length < 4) { setErr("반 코드는 4자 이상이에요"); return; }
    setBusy(true);
    setTimeout(() => onLogin({ name: name.trim(), classCode: code.trim().toUpperCase() }), 350);
  }

  const orbs = [
    [220,"#4f8cff","12%","8%",3.8],
    [160,"#7c3aed","78%","72%",4.5],
    [260,"#06b6d4","68%","12%",5.2],
    [110,"#f59e0b","22%","78%",3.2],
  ];

  return (
    <div style={{ minHeight:"100dvh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0a0f1e", padding:24, position:"relative", overflow:"hidden" }}>
      {orbs.map(([sz,cl,top,left,dur],i) => (
        <div key={i} style={{ position:"absolute", width:sz, height:sz, borderRadius:"50%", background:cl, opacity:.07, top, left, filter:"blur(70px)", animation:`pulse ${dur}s ease-in-out infinite`, animationDelay:`${i*.6}s`, pointerEvents:"none" }} />
      ))}

      <div style={{ width:"100%", maxWidth:400, position:"relative", zIndex:1, animation:"fadeUp .5s ease" }}>
        {/* 로고 */}
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ fontSize:60, display:"inline-block", marginBottom:14, animation:"float 3.5s ease-in-out infinite" }}>🏫</div>
          <h1 style={{ fontSize:30, fontWeight:900, color:"#fff", letterSpacing:-1, lineHeight:1.15 }}>
            세종대성<br/>
            <span style={{ background:"linear-gradient(90deg,#60a5fa,#a78bfa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>클래스</span>
          </h1>
          <p style={{ color:"#475569", fontSize:13, marginTop:10 }}>우리 반 전용 일정 · 공지 앱</p>
        </div>

        <div style={{ background:"rgba(255,255,255,.05)", backdropFilter:"blur(24px)", border:"1px solid rgba(255,255,255,.1)", borderRadius:24, padding:"32px 28px" }}>
          {[
            { label:"이름",    val:name, set:(v)=>setName(v),           ph:"홍길동",           isCode:false },
            { label:"반 코드", val:code, set:(v)=>setCode(v.toUpperCase()), ph:"예: AB12 (4자 이상)", isCode:true  },
          ].map(({ label, val, set, ph, isCode }) => (
            <div key={label} style={{ marginBottom:16 }}>
              <label style={{ display:"block", fontSize:11, fontWeight:700, color:"#64748b", letterSpacing:1.2, marginBottom:8 }}>{label.toUpperCase()}</label>
              <input
                value={val} placeholder={ph}
                onChange={e => { set(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && submit()}
                style={{ width:"100%", padding:"14px 16px", background:"rgba(255,255,255,.07)", border:"1.5px solid rgba(255,255,255,.13)", borderRadius:12, color:"#f1f5f9", fontSize:15, letterSpacing: isCode ? 2 : 0, fontWeight: isCode ? 700 : 400 }}
              />
            </div>
          ))}

          {err && (
            <div style={{ fontSize:12, color:"#fca5a5", background:"rgba(239,68,68,.12)", borderRadius:10, padding:"9px 13px", marginBottom:14 }}>⚠️ {err}</div>
          )}

          <button className="btn-primary" onClick={submit} disabled={busy} style={{ width:"100%", marginTop:4, padding:"15px", fontSize:15, fontWeight:800 }}>
            {busy ? "입장 중..." : "입장하기 →"}
          </button>

          <p style={{ textAlign:"center", fontSize:11, color:"#475569", marginTop:14, lineHeight:1.8 }}>
            💡 같은 코드를 쓰면 같은 반으로 묶여요<br/>
            <span style={{ color:"#60a5fa", fontWeight:700 }}>DEMO</span> 코드로 체험해볼 수 있어요
          </p>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 메인 앱 (레이아웃)
// ══════════════════════════════════════════════════════
function MainApp({ user, page, setPage, onLogout }) {
  const { isMobile } = useBreakpoint();
  const [schedules, setSchedules] = useState([]);
  const [notices,   setNotices]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [toast,     setToast]     = useState(null);

  const showToast = useCallback((msg, type = "info") => {
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
        showToast("❌ 데이터 로드 실패", "error");
      }
      setLoading(false);
    })();
  }, [user.classCode]);

  const todayStr = getTodayStr();
  const upcoming = schedules.filter(s => s.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date));
  const todaySch = schedules.filter(s => s.date === todayStr);

  const NAV = [
    { id:"home",     icon:"🏠", label:"홈" },
    { id:"schedule", icon:"📅", label:"일정" },
    { id:"notice",   icon:"📢", label:"공지" },
    { id:"lunch",    icon:"🍱", label:"급식" },
  ];

  const pages = {
    home:     <HomePage     user={user} schedules={schedules} notices={notices} upcoming={upcoming} todaySch={todaySch} setPage={setPage} loading={loading} />,
    schedule: <SchedulePage user={user} schedules={schedules} setSchedules={setSchedules} showToast={showToast} />,
    notice:   <NoticePage   user={user} notices={notices} setNotices={setNotices} showToast={showToast} />,
    lunch:    <LunchPage />,
  };

  return (
    <div style={{ minHeight:"100dvh", display:"flex", background:"#f0f4ff" }}>

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom: isMobile ? 88 : 24, left:"50%", transform:"translateX(-50%)", background: toast.type==="error" ? "#ef4444" : "#1e293b", color:"#fff", padding:"11px 22px", borderRadius:30, fontSize:13, fontWeight:600, zIndex:9999, whiteSpace:"nowrap", boxShadow:"0 8px 28px rgba(0,0,0,.22)", animation:"toastIn .25s ease" }}>
          {toast.msg}
        </div>
      )}

      {/* ─ 사이드바 (태블릿+) ─ */}
      {!isMobile && (
        <aside style={{ width:230, minHeight:"100dvh", background:"#fff", borderRight:"1px solid #e8eef8", display:"flex", flexDirection:"column", boxShadow:"2px 0 20px rgba(79,140,255,.06)", position:"sticky", top:0, height:"100dvh", flexShrink:0 }}>
          <div style={{ padding:"28px 20px 18px", borderBottom:"1px solid #f0f4ff" }}>
            <div style={{ fontSize:30, marginBottom:10 }}>🏫</div>
            <div style={{ fontSize:16, fontWeight:900, color:"#1e293b", letterSpacing:-.5 }}>세종대성 클래스</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>{user.classCode} 반</div>
          </div>
          <nav style={{ flex:1, padding:"14px 12px" }}>
            {NAV.map(n => (
              <button key={n.id} className={`side-nav-btn${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:19 }}>{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
          <div style={{ padding:"16px", borderTop:"1px solid #f0f4ff" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
              <div style={{ width:38, height:38, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:15, flexShrink:0 }}>
                {user.name[0]}
              </div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
                <div style={{ fontSize:11, color:"#94a3b8" }}>{user.classCode} 반</div>
              </div>
            </div>
            <button onClick={onLogout} style={{ width:"100%", padding:"9px", borderRadius:10, border:"1px solid #e8eef8", background:"#f8faff", color:"#94a3b8", fontSize:12, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e => { e.target.style.background="#fff1f1"; e.target.style.color="#ef4444"; e.target.style.borderColor="#fecaca"; }}
              onMouseLeave={e => { e.target.style.background="#f8faff"; e.target.style.color="#94a3b8"; e.target.style.borderColor="#e8eef8"; }}>
              로그아웃
            </button>
          </div>
        </aside>
      )}

      {/* ─ 콘텐츠 영역 ─ */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0 }}>

        {/* 모바일 헤더 */}
        {isMobile && (
          <header style={{ background:"linear-gradient(135deg,#1d4ed8,#4f46e5)", padding:"14px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:"0 4px 20px rgba(29,78,216,.28)", flexShrink:0 }}>
            <div>
              <div style={{ fontSize:10, color:"rgba(255,255,255,.6)", letterSpacing:2, fontWeight:700 }}>{user.classCode} 반</div>
              <div style={{ fontSize:16, fontWeight:800, color:"#fff" }}>안녕하세요, {user.name}님 👋</div>
            </div>
            <button onClick={onLogout} style={{ background:"rgba(255,255,255,.15)", border:"none", padding:"7px 14px", borderRadius:20, color:"rgba(255,255,255,.9)", fontSize:12, fontWeight:600, cursor:"pointer" }}>나가기</button>
          </header>
        )}

        {/* 데스크탑/태블릿 상단 바 */}
        {!isMobile && (
          <header style={{ background:"#fff", borderBottom:"1px solid #e8eef8", padding:"16px 32px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
            <div>
              <h2 style={{ fontSize:18, fontWeight:900, color:"#1e293b" }}>
                {{ home:"🏠 홈", schedule:"📅 일정 관리", notice:"📢 공지 공유", lunch:"🍱 급식 메뉴" }[page]}
              </h2>
              <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>
                {new Date().toLocaleDateString("ko-KR",{ year:"numeric", month:"long", day:"numeric", weekday:"long" })}
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:36, height:36, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:900, fontSize:14 }}>
                {user.name[0]}
              </div>
              <div style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{user.name}</div>
            </div>
          </header>
        )}

        {/* 페이지 */}
        <main style={{ flex:1, overflowY:"auto", padding: isMobile ? "20px 16px" : "28px 32px", paddingBottom: isMobile ? 88 : 32 }}>
          {loading
            ? <div style={{ textAlign:"center", padding:"80px 20px" }}><div style={{ fontSize:40, animation:"float 1.5s ease-in-out infinite" }}>⏳</div><div style={{ fontSize:14, color:"#94a3b8", marginTop:14, fontWeight:600 }}>불러오는 중...</div></div>
            : <div key={page} style={{ animation:"slideUp .3s ease" }}>{pages[page]}</div>
          }
        </main>

        {/* 모바일 하단 탭 */}
        {isMobile && (
          <nav style={{ position:"fixed", bottom:0, left:0, right:0, background:"#fff", borderTop:"1px solid #e8eef8", display:"grid", gridTemplateColumns:"repeat(4,1fr)", boxShadow:"0 -4px 20px rgba(0,0,0,.07)", zIndex:100 }}>
            {NAV.map(n => (
              <button key={n.id} className={`bottom-tab${page===n.id?" active":""}`} onClick={() => setPage(n.id)}>
                <span style={{ fontSize:22 }}>{n.icon}</span>
                <span style={{ fontSize:10, fontWeight: page===n.id ? 800 : 500, color: page===n.id ? "#1d4ed8" : "#94a3b8" }}>{n.label}</span>
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
  const urgentSchedules = upcoming.filter(s => getDday(s.date).urgent).slice(0, 4);

  return (
    <div style={{ maxWidth:960, margin:"0 auto" }}>

      {/* 오늘 카드 */}
      <div style={{ background:"linear-gradient(135deg,#1d4ed8,#4f46e5 55%,#7c3aed)", borderRadius:22, padding: isMobile ? "22px 22px 20px" : "28px 32px", marginBottom:24, color:"#fff", boxShadow:"0 12px 40px rgba(29,78,216,.28)", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", right:-30, top:-30, width:180, height:180, borderRadius:"50%", background:"rgba(255,255,255,.07)" }} />
        <div style={{ position:"absolute", right:60, bottom:-50, width:220, height:220, borderRadius:"50%", background:"rgba(255,255,255,.04)" }} />
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:11, color:"rgba(255,255,255,.6)", fontWeight:700, letterSpacing:2, marginBottom:5 }}>TODAY</div>
          <div style={{ fontSize: isMobile ? 22 : 26, fontWeight:900, letterSpacing:-.5, marginBottom: todaySch.length ? 14 : 0 }}>
            {now.getMonth()+1}월 {now.getDate()}일 {dayNames[now.getDay()]}
          </div>
          {todaySch.length > 0
            ? todaySch.map(s => {
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ background:"rgba(255,255,255,.15)", backdropFilter:"blur(10px)", borderRadius:12, padding:"10px 14px", display:"flex", alignItems:"center", gap:10, marginTop:8 }}>
                  <span style={{ fontSize:16 }}>{meta.icon}</span>
                  <span style={{ fontSize:14, fontWeight:600, flex:1 }}>{s.title}</span>
                  <span className="tag" style={{ background:"rgba(255,255,255,.2)", color:"#fff" }}>{s.type}</span>
                </div>
              );
            })
            : <div style={{ fontSize:13, color:"rgba(255,255,255,.5)", marginTop:6 }}>오늘 등록된 일정이 없어요 😌</div>
          }
        </div>
      </div>

      {/* 2열 그리드 */}
      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:18 }}>

        {/* 다가오는 일정 */}
        <div className="card" style={{ padding:22 }}>
          <SectionHeader title="⏳ 다가오는 일정" onMore={() => setPage("schedule")} />
          {upcoming.length === 0
            ? <EmptyMini icon="📅" text="다가오는 일정이 없어요" />
            : upcoming.slice(0,4).map(s => {
              const dd   = getDday(s.date);
              const meta = TYPE_META[s.type] || TYPE_META["기타"];
              return (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #f8faff" }}>
                  <div style={{ width:38, height:38, borderRadius:10, background:meta.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, flexShrink:0 }}>{meta.icon}</div>
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

        {/* 최근 공지 */}
        <div className="card" style={{ padding:22 }}>
          <SectionHeader title="📢 최근 공지" onMore={() => setPage("notice")} />
          {notices.length === 0
            ? <EmptyMini icon="📢" text="공지가 없어요" />
            : notices.slice(0,3).map(n => (
              <div key={n.id} style={{ padding:"10px 0", borderBottom:"1px solid #f8faff" }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#1e293b", marginBottom:3 }}>{n.title}</div>
                <div style={{ fontSize:12, color:"#64748b", lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{n.content}</div>
                <div style={{ fontSize:10, color:"#cbd5e1", marginTop:5 }}>{n.authorName}</div>
              </div>
            ))
          }
        </div>

        {/* D-Day 임박 카드들 */}
        {urgentSchedules.map((s, i) => {
          const dd   = getDday(s.date);
          const meta = TYPE_META[s.type] || TYPE_META["기타"];
          return (
            <div key={s.id} className="card hover-card" onClick={() => setPage("schedule")} style={{ padding:22, borderLeft:`4px solid ${meta.color}`, animation:`popIn .35s ease ${i*.08}s both` }}>
              <span className="tag" style={{ background:meta.bg, color:meta.color, marginBottom:12 }}>{meta.icon} {s.type}</span>
              <div style={{ fontSize:15, fontWeight:800, color:"#1e293b", marginBottom:3 }}>{s.title}</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:14 }}>{s.date}</div>
              <div style={{ fontSize:34, fontWeight:900, color:dd.color, letterSpacing:-1 }}>{dd.label}</div>
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
  const { isMobile } = useBreakpoint();
  const [showForm, setShowForm] = useState(false);
  const [form,    setForm]     = useState({ title:"", date:"", type:"수행평가" });
  const [saving,  setSaving]   = useState(false);
  const todayStr = getTodayStr();

  const upcoming = schedules.filter(s => s.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date));
  const past     = schedules.filter(s => s.date < todayStr).sort((a,b) => b.date.localeCompare(a.date));

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
      <PageHeader title="일정 관리" sub="수행평가·시험·행사를 등록해요" action={
        <button onClick={() => setShowForm(!showForm)} style={{ padding:"10px 20px", border:"none", borderRadius:12, background: showForm ? "#f1f5f9" : "linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm ? "#64748b" : "#fff", fontSize:13, fontWeight:700, cursor:"pointer", boxShadow: showForm ? "none" : "0 4px 16px rgba(79,140,255,.3)", transition:"all .2s" }}>
          {showForm ? "✕ 닫기" : "+ 일정 추가"}
        </button>
      } />

      {showForm && (
        <div className="card" style={{ padding:24, marginBottom:22, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr 1fr", gap:12, marginBottom:16 }}>
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
        <section style={{ marginBottom:28 }}>
          <GroupLabel>다가오는 일정 ({upcoming.length})</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:12 }}>
            {upcoming.map(s=><SchedCard key={s.id} s={s} user={user} onDel={del} />)}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <GroupLabel faded>지난 일정</GroupLabel>
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:10, opacity:.5 }}>
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
    <div className="card hover-card" style={{ padding:18, borderLeft:`3px solid ${dd.urgent&&!past ? meta.color : "#f0f4ff"}` }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
        <span className="tag" style={{ background:meta.bg, color:meta.color }}>{meta.icon} {s.type}</span>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {!past && <span style={{ fontSize:13, fontWeight:900, color:dd.color }}>{dd.label}</span>}
          {s.authorName === user.name && (
            <button onClick={()=>onDel(s.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:15, cursor:"pointer", padding:2, lineHeight:1, transition:"color .15s" }}
              onMouseEnter={e=>e.target.style.color="#ef4444"} onMouseLeave={e=>e.target.style.color="#e2e8f0"}>✕</button>
          )}
        </div>
      </div>
      <div style={{ fontSize:14, fontWeight:800, color:"#1e293b", marginBottom:4 }}>{s.title}</div>
      <div style={{ fontSize:11, color:"#94a3b8" }}>{s.date.slice(5).replace("-","/")} · {s.authorName}</div>
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
    <div style={{ maxWidth:820, margin:"0 auto" }}>
      <PageHeader title="공지 공유" sub="친구들에게 중요한 내용을 공유해요" action={
        <button onClick={() => setShowForm(!showForm)} style={{ padding:"10px 20px", border:"none", borderRadius:12, background: showForm ? "#f1f5f9" : "linear-gradient(135deg,#4f8cff,#7c3aed)", color: showForm ? "#64748b" : "#fff", fontSize:13, fontWeight:700, cursor:"pointer", boxShadow: showForm ? "none" : "0 4px 16px rgba(79,140,255,.3)", transition:"all .2s" }}>
          {showForm ? "✕ 닫기" : "+ 공지 작성"}
        </button>
      } />

      {showForm && (
        <div className="card" style={{ padding:24, marginBottom:22, animation:"popIn .25s ease", borderTop:"3px solid #4f8cff" }}>
          <div style={{ marginBottom:12 }}>
            <label style={LBL}>제목</label>
            <input className="input-field" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="예: 내일 체육복 지참" />
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={LBL}>내용</label>
            <textarea className="input-field" value={form.content} onChange={e=>setForm({...form,content:e.target.value})} placeholder="자세한 내용을 써주세요" rows={4} style={{ resize:"none", lineHeight:1.7 }} />
          </div>
          <button className="btn-primary" onClick={add} disabled={saving}>{saving?"등록 중...":"공지 올리기"}</button>
        </div>
      )}

      {notices.length === 0
        ? <EmptyFull icon="📢" text="아직 공지가 없어요" sub="위 버튼으로 친구들에게 알려주세요!" />
        : (
          <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:14 }}>
            {notices.map(n => (
              <div key={n.id} className="card hover-card" style={{ padding:22, animation:"popIn .3s ease" }}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                  <div style={{ fontSize:15, fontWeight:800, color:"#1e293b", flex:1, lineHeight:1.4, paddingRight:8 }}>{n.title}</div>
                  {n.authorName === user.name && (
                    <button onClick={()=>del(n.id)} style={{ background:"none", border:"none", color:"#e2e8f0", fontSize:15, cursor:"pointer", flexShrink:0, lineHeight:1, transition:"color .15s" }}
                      onMouseEnter={e=>e.target.style.color="#ef4444"} onMouseLeave={e=>e.target.style.color="#e2e8f0"}>✕</button>
                  )}
                </div>
                <div style={{ fontSize:13, color:"#475569", lineHeight:1.75, marginBottom:14 }}>{n.content}</div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:26, height:26, borderRadius:"50%", background:"linear-gradient(135deg,#4f8cff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:11, fontWeight:900, flexShrink:0 }}>{n.authorName[0]}</div>
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
  const todayStr  = getTodayStr();
  const todayMenu = SAMPLE_LUNCH[todayStr];
  const menuDays  = Object.entries(SAMPLE_LUNCH).sort(([a],[b]) => a.localeCompare(b));
  const dayKr     = ["일","월","화","수","목","금","토"];

  return (
    <div style={{ maxWidth:820, margin:"0 auto" }}>
      <PageHeader title="급식 메뉴" sub="NEIS API 연동 전 샘플 데이터예요" />

      {todayMenu ? (
        <div style={{ background:"linear-gradient(135deg,#059669,#10b981 60%,#34d399)", borderRadius:20, padding: isMobile ? "22px" : "26px 30px", marginBottom:22, color:"#fff", boxShadow:"0 10px 32px rgba(16,185,129,.28)", position:"relative", overflow:"hidden" }}>
          <div style={{ position:"absolute", right:-20, top:-20, width:150, height:150, borderRadius:"50%", background:"rgba(255,255,255,.08)", pointerEvents:"none" }} />
          <div style={{ fontSize:11, color:"rgba(255,255,255,.7)", fontWeight:700, letterSpacing:2, marginBottom:10 }}>TODAY'S LUNCH</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {todayMenu.map((item,i)=>(
              <span key={i} style={{ background:"rgba(255,255,255,.2)", backdropFilter:"blur(8px)", padding:"8px 15px", borderRadius:20, fontSize:14, fontWeight:600 }}>{item}</span>
            ))}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding:28, textAlign:"center", color:"#94a3b8", marginBottom:22 }}>오늘은 급식 정보가 없어요 😢</div>
      )}

      <div style={{ display:"grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap:12 }}>
        {menuDays.map(([date, menu]) => {
          const d = new Date(date);
          const isToday = date === todayStr;
          return (
            <div key={date} className="card hover-card" style={{ padding:18, borderLeft:`3px solid ${isToday?"#10b981":"#f0f4ff"}` }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                <span className="tag" style={{ background: isToday?"#d1fae5":"#f1f5f9", color: isToday?"#059669":"#64748b" }}>
                  {date.slice(5).replace("-","/")} ({dayKr[d.getDay()]})
                </span>
                {isToday && <span style={{ fontSize:11, color:"#059669", fontWeight:700 }}>오늘</span>}
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {menu.map((item,i)=>(
                  <span key={i} style={{ fontSize:12, padding:"5px 10px", borderRadius:20, background:"#f8faff", color:"#475569", fontWeight:500 }}>{item}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// 공통 컴포넌트
// ══════════════════════════════════════════════════════
function PageHeader({ title, sub, action }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
      <div>
        <h2 style={{ fontSize:20, fontWeight:900, color:"#1e293b" }}>{title}</h2>
        {sub && <p style={{ fontSize:12, color:"#94a3b8", marginTop:3 }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function SectionHeader({ title, onMore }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
      <div style={{ fontSize:14, fontWeight:800, color:"#1e293b" }}>{title}</div>
      <button onClick={onMore} style={{ background:"none", border:"none", fontSize:12, color:"#94a3b8", fontWeight:600, cursor:"pointer" }}>더보기 →</button>
    </div>
  );
}

function GroupLabel({ children, faded }) {
  return <div style={{ fontSize:11, fontWeight:700, color: faded?"#cbd5e1":"#94a3b8", letterSpacing:1.5, marginBottom:12 }}>{children}</div>;
}

function EmptyMini({ icon, text }) {
  return <div style={{ textAlign:"center", padding:"24px 0", color:"#cbd5e1" }}><span style={{ fontSize:28 }}>{icon}</span><div style={{ fontSize:12, fontWeight:600, marginTop:8 }}>{text}</div></div>;
}

function EmptyFull({ icon, text, sub }) {
  return (
    <div style={{ textAlign:"center", padding:"72px 20px", color:"#94a3b8" }}>
      <div style={{ fontSize:50, marginBottom:14 }}>{icon}</div>
      <div style={{ fontSize:16, fontWeight:700, color:"#64748b", marginBottom:6 }}>{text}</div>
      {sub && <div style={{ fontSize:13 }}>{sub}</div>}
    </div>
  );
}

const LBL = { display:"block", fontSize:11, fontWeight:700, color:"#64748b", letterSpacing:.5, marginBottom:7 };