import "./_group.css";
import { useState } from "react";
import { CarFront, CircleHelp, Clock3, LocateFixed, MapPin, Menu, MessageCircle, Navigation, Phone, ShieldCheck, WalletCards } from "lucide-react";

const vehicles = [["Mini", "PKR 480"], ["Sedan", "PKR 620"], ["6 Seater", "PKR 880"], ["Highroof", "PKR 1,150"]];
const histories = [["Gulberg III", "DHA Phase 5", "PKR 620"], ["Johar Town", "Allama Iqbal Airport", "PKR 945"]];

export function Current() {
  const [vehicle, setVehicle] = useState(1);
  const [tab, setTab] = useState<"book" | "rides" | "help">("book");
  const [requested, setRequested] = useState(false);
  const [toast, setToast] = useState("");
  const [pickup, setPickup] = useState("Packages Mall, Walton Road");
  const [dropoff, setDropoff] = useState("Liberty Market, Gulberg III");
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 1800); };
  return (
    <main className="myride-shell" style={{ position: "relative", height: "100dvh" }}>
      <section className="map-grid" aria-label="Simulated map">
        <div className="route-line" /><div className="map-pin pickup"><MapPin size={13} /></div><div className="map-pin dropoff"><MapPin size={13} /></div>
        <div className="driver-dot"><CarFront size={14} /></div><div className="map-label one">Model Town</div><div className="map-label two">Gulberg</div><div className="map-label three">DHA Phase 5</div>
      </section>
      <header className="topbar"><div><div className="wordmark">My <span>Ride</span></div><div className="small-label" style={{ marginTop: 2 }}>Customer</div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><button className="icon-button" onClick={() => notify("Safety center opened")} aria-label="Safety"><ShieldCheck size={16} /></button><div className="avatar">AK</div><button className="icon-button" onClick={() => notify("Menu opened")} aria-label="Menu"><Menu size={17} /></button></div></header>
      <section className="bottom-panel">
        <div className="grabber" />
        {requested ? <div className="panel-pad"><div className="ride-card"><div className="ride-card-head"><span className="status"><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "currentColor", marginRight: 5 }} /> Driver arriving</span><span className="mono" style={{ color: "var(--signal)", fontSize: 12 }}>04 min</span></div><h3>Rehan is on the way</h3><p>White Toyota Corolla · LEB-23-418</p><div className="ride-card-actions"><button className="ghost-button" onClick={() => notify("Calling Rehan")}><Phone size={13} /> Call</button><button className="ghost-button" onClick={() => notify("Message thread opened")}><MessageCircle size={13} /> Message</button><button className="ghost-button" onClick={() => setRequested(false)}>Cancel</button></div></div><div style={{ display: "flex", justifyContent: "space-between", marginTop: 13, color: "var(--muted)", fontSize: 11 }}><span>Arriving at Packages Mall</span><span className="mono">PKR 620</span></div></div> :
          <><nav className="tabs">{[["book", "Book ride"], ["rides", "Your rides"], ["help", "Help & safety"]].map(([key, label]) => <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key as typeof tab)}>{key === "book" ? <Navigation size={15} /> : key === "rides" ? <Clock3 size={15} /> : <CircleHelp size={15} />}{label}</button>)}</nav>
          {tab === "book" && <div className="panel-pad"><div className="small-label" style={{ marginBottom: 10 }}>Where are you going?</div><div className="route-fields"><label className="field"><i style={{ color: "var(--blue)" }}><LocateFixed size={13} /></i><input value={pickup} onChange={e => setPickup(e.target.value)} aria-label="Pickup" /></label><label className="field"><i style={{ color: "#e89563" }}><MapPin size={13} /></i><input value={dropoff} onChange={e => setDropoff(e.target.value)} aria-label="Drop-off" /></label></div><div className="vehicle-row">{vehicles.map(([name, fare], index) => <button key={name} className={`vehicle ${vehicle === index ? "selected" : ""}`} onClick={() => setVehicle(index)}><CarFront size={16} /><strong>{name}</strong><span>{fare}</span></button>)}</div><div className="fare-line"><div><div className="small-label">Quoted fare</div><div style={{ color: "var(--muted)", fontSize: 10 }}>6.8 km · 21 min</div></div><div className="fare-value">PKR {vehicles[vehicle][1].replace("PKR ", "")}</div></div><div className="pay-select"><span><WalletCards size={14} style={{ verticalAlign: "middle", marginRight: 7 }} /> Cash</span><span style={{ color: "var(--muted)" }}>Change</span></div><button className="primary-button" onClick={() => setRequested(true)}>Request {vehicles[vehicle][0]} <span style={{ opacity: .7 }}>→</span></button></div>}
          {tab === "rides" && <div className="panel-pad"><div className="small-label">Recent rides</div>{histories.map(([from, to, fare]) => <div key={from} className="journey-row"><MapPin size={15} className="journey-icon" /><div style={{ flex: 1 }}><p>{from} → {to}</p><small>Today · completed</small></div><strong className="mono" style={{ fontSize: 11 }}>{fare}</strong></div>)}</div>}
          {tab === "help" && <div className="panel-pad"><div className="journey-card"><div className="chip"><ShieldCheck size={13} /> You’re covered</div><h3 style={{ margin: "12px 0 5px" }}>Need a hand?</h3><p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>Reach support or share your live trip with a trusted contact.</p><button className="primary-button" style={{ marginTop: 14 }} onClick={() => notify("Support request started")}>Contact support</button></div></div>}</>}
      </section>{toast && <div className="toast">{toast}</div>}
    </main>
  );
}