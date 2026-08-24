import { Bell, CircleHelp, MapPin, Menu, Navigation, Wallet } from "lucide-react";
import { useState } from "react";
import "./_group.css";

const money = (value: string) => <span className="mono">{value}</span>;

export function Current() {
  const [online, setOnline] = useState(true);
  const [offer, setOffer] = useState(true);
  const [message, setMessage] = useState("");
  const action = (text: string) => { setOffer(false); setMessage(text); };
  return <main className="myride-preview" style={{minHeight:"720px",height:"100dvh"}}>
    <div className="map-surface"><div className="map-road"/><div className="map-road two"/>
      <span className="map-label" style={{left:25,top:260}}>Gulberg III</span><span className="map-label" style={{right:28,top:160}}>MM Alam Rd</span>
      <span className="map-pin pick" style={{left:"35%",top:"45%"}}/><span className="map-pin" style={{left:"67%",top:"28%"}}/><div className="map-car"/>
    </div>
    <header className="topbar"><div className="brand">My <em>Ride</em><small>DRIVER CONSOLE</small></div><div style={{display:"flex",gap:8}}><button className="icon-btn" onClick={()=>setMessage("No new notifications")}><Bell size={16}/></button><button className="icon-btn" onClick={()=>setMessage("Menu opened")}><Menu size={16}/></button></div></header>
    <div className="online-pill glass"><div><strong>{online ? "You’re online" : "You’re offline"}</strong><span>{online ? "Looking for rides near Gulberg" : "Go online when you’re ready"}</span></div><button aria-label="Toggle online status" className={`toggle ${online?"on":""}`} onClick={()=>setOnline(!online)}><i/></button></div>
    {offer && online ? <section className="bottom-sheet glass">
      <div className="sheet-handle"/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div className="eyebrow" style={{color:"var(--yellow)"}}>New ride request</div><h1 className="sheet-title">Johar Town → DHA</h1></div><strong className="mono" style={{color:"var(--yellow)",fontSize:18}}>00:18</strong></div>
      <div className="route"><div className="route-row"><span className="dot"/><span>Expo Center, Johar Town</span></div><div className="route-line"/><div className="route-row"><span className="dot end"/><span>Packages Mall, DHA Phase 6</span></div></div>
      <div className="metric-row"><div className="metric"><b>{money("PKR 640")}</b><span>EST. FARE</span></div><div className="metric"><b>11.4 km</b><span>TRIP DISTANCE</span></div><div className="metric"><b>24 min</b><span>DRIVE TIME</span></div></div>
      <div style={{display:"flex",gap:8,marginTop:12}}><button className="secondary" onClick={()=>action("Request declined")}>Decline</button><button className="primary" onClick={()=>action("Ride accepted — navigate to pickup")}>Accept ride</button></div>{message&&<div className="toast-note">{message}</div>}
    </section> : <section className="bottom-sheet glass"><div className="sheet-handle"/><div className="eyebrow">Current balance</div><h1 className="sheet-title">{money("PKR 3,840")}</h1><p className="subtle">No active requests · You’re in a high-demand zone</p><button className="primary" style={{marginTop:14}} onClick={()=>setMessage("Refreshing nearby demand")}> <Navigation size={15} style={{verticalAlign:"middle"}}/> Refresh nearby demand</button>{message&&<div className="toast-note">{message}</div>}</section>}
    <div style={{position:"absolute",left:16,bottom:20,zIndex:3}}><button className="icon-btn" onClick={()=>setMessage("Support is ready to help")}><CircleHelp size={17}/></button></div>
  </main>;
}