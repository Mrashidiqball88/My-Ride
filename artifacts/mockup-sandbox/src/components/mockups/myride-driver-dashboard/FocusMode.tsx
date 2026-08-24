import { Check, ChevronUp, CircleHelp, MapPin, MessageCircle, Navigation, Phone, Shield, X } from "lucide-react";
import { useState } from "react";
import "./_group.css";

export function FocusMode() {
  const [stage,setStage]=useState<"pickup"|"riding"|"done">("pickup");
  const next=stage==="pickup"?"Mark arrived":stage==="riding"?"Complete ride":"Done";
  return <main className="myride-preview" style={{minHeight:"720px",background:"#132021"}}><div className="map-surface"><div className="map-road"/><div className="map-road two"/><span className="map-label" style={{left:21,top:225}}>Gulberg Main Blvd</span><span className="map-label" style={{right:22,top:122}}>DHA Phase 4</span><div className="map-pin pick" style={{left:"28%",top:"35%"}}/><div className="map-car" style={{left:"48%",top:"53%"}}/></div>
    <div style={{position:"relative",zIndex:4,padding:"15px 16px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div className="brand">My <em>Ride</em><small>FOCUS MODE</small></div><button className="icon-btn"><CircleHelp size={16}/></button></div>
      <div className="glass" style={{marginTop:18,borderRadius:16,padding:"11px 13px",display:"flex",alignItems:"center",gap:10}}><Shield color="var(--cyan)" size={17}/><span style={{fontSize:12}}>Trip safety mode is on</span><span style={{marginLeft:"auto",fontSize:10,color:"var(--cyan)"}}>ACTIVE</span></div>
      <div style={{marginTop:245,textAlign:"center"}}><div style={{display:"inline-flex",alignItems:"center",gap:7,padding:"7px 11px",borderRadius:30,background:"rgba(17,24,25,.86)",fontSize:11}}><span className="dot" style={{width:7,height:7}}/>{stage==="pickup"?"Heading to pickup":stage==="riding"?"Passenger on board":"Trip complete"}</div></div>
      <section className="glass" style={{marginTop:14,borderRadius:22,padding:16}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"start"}}><div><div className="eyebrow">{stage==="pickup"?"NEXT ACTION":"CURRENT TRIP"}</div><h1 className="sheet-title">{stage==="pickup"?"Arrive at pickup":"Model Town Park"}</h1></div><b className="mono" style={{color:"var(--yellow)"}}>{stage==="done"?"PKR 520":"08 min"}</b></div><p className="subtle" style={{marginTop:5}}>{stage==="pickup"?"Ayesha · Expo Center Gate 2":"Drop-off · Model Town Link Road"}</p>
        <div className="route"><div className="route-row"><span className="dot"/><span>{stage==="pickup"?"Expo Center, Johar Town":"Packages Mall, DHA Phase 6"}</span></div><div className="route-line"/><div className="route-row"><span className="dot end"/><span>Model Town Park, Gate 1</span></div></div>
        {stage!=="done"?<><button className="primary" onClick={()=>setStage(stage==="pickup"?"riding":"done")}><Navigation size={15} style={{verticalAlign:"middle"}}/> {next}</button><div style={{display:"flex",gap:8,marginTop:9}}><button className="secondary"><Phone size={14}/> Call</button><button className="secondary"><MessageCircle size={14}/> Message</button></div></>:<div className="toast-note"><Check size={14} style={{verticalAlign:"middle"}}/> Payment added to today’s earnings</div>}</section>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:11}}><span className="subtle">PKR 520 estimated fare</span><button className="icon-btn" style={{width:28,height:28}}><ChevronUp size={14}/></button></div>
    </div>
  </main>
}