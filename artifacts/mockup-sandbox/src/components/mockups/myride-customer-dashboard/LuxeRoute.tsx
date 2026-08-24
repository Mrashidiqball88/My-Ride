import { useState } from "react";
import { CarFront, CircleHelp, Clock3, LocateFixed, MapPin, Menu, MessageCircle, Navigation, Phone, ShieldCheck, WalletCards } from "lucide-react";
import "./LuxeRoute.css";

const vehicles = [
  { name: "Mini", fare: "PKR 480" },
  { name: "Sedan", fare: "PKR 620" },
  { name: "6 Seater", fare: "PKR 880" },
  { name: "Highroof", fare: "PKR 1,150" },
];

const histories = [
  ["Gulberg III", "DHA Phase 5", "PKR 620", "Today · completed"],
  ["Johar Town", "Allama Iqbal Airport", "PKR 945", "Yesterday · completed"],
  ["Model Town", "Packages Mall", "PKR 510", "18 Aug · completed"],
];

type Tab = "book" | "rides" | "help";

export function LuxeRoute() {
  const [vehicle, setVehicle] = useState(1);
  const [tab, setTab] = useState<Tab>("book");
  const [requested, setRequested] = useState(false);
  const [toast, setToast] = useState("");
  const [pickup, setPickup] = useState("Packages Mall, Walton Road");
  const [dropoff, setDropoff] = useState("Liberty Market, Gulberg III");

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  };

  return (
    <main className="luxe-route">
      <section className="lr-map" aria-label="Simulated Lahore route map">
        <div className="lr-map-grid" />
        <div className="lr-road a" /><div className="lr-road b" /><div className="lr-road c" />
        <div className="lr-map-label one">Model Town</div>
        <div className="lr-map-label two">Gulberg III</div>
        <div className="lr-map-label three">DHA Phase 5</div>
        <div className="lr-map-label four">Walton Road</div>
        <div className="lr-route-trace" />
        <div className="lr-pin pickup"><LocateFixed size={12} /></div>
        <div className="lr-pin dropoff"><MapPin size={12} /></div>
        <div className="lr-car"><CarFront size={14} /></div>
        <header className="lr-header">
          <div>
            <div className="lr-brand">My <span>Ride</span></div>
            <div className="lr-kicker">Customer / Lahore</div>
          </div>
          <div className="lr-avatar" aria-label="Account initials">AK</div>
        </header>
        <div className="lr-map-tools">
          <button className="lr-round-button" onClick={() => notify("Safety center opened")} aria-label="Open safety center"><ShieldCheck size={15} /></button>
          <button className="lr-round-button" onClick={() => notify("Menu opened")} aria-label="Open menu"><Menu size={16} /></button>
        </div>
      </section>

      <section className="lr-sheet">
        <div className="lr-grabber" />
        {requested ? (
          <div>
            <div className="lr-active-card">
              <div className="lr-active-top">
                <span className="lr-status"><span aria-hidden="true">●</span> Driver arriving</span>
                <span className="lr-minutes">04 min</span>
              </div>
              <h3>Rehan is on the way</h3>
              <p>Your driver has found the fastest route to you.</p>
              <div className="lr-active-meta">
                <strong>White Toyota Corolla · LEB-23-418</strong>
                <span>4.9 rating · Cash payment</span>
              </div>
              <div className="lr-actions">
                <button className="lr-secondary" onClick={() => notify("Calling Rehan")}><Phone size={12} /> Call</button>
                <button className="lr-secondary" onClick={() => notify("Message thread opened")}><MessageCircle size={12} /> Message</button>
                <button className="lr-secondary" onClick={() => setRequested(false)}>Cancel</button>
              </div>
            </div>
            <div className="lr-arrival"><span>Arriving at Packages Mall</span><strong>PKR 620</strong></div>
          </div>
        ) : (
          <>
            <nav className="lr-tabs" aria-label="Customer dashboard sections">
              <button className={`lr-tab ${tab === "book" ? "active" : ""}`} onClick={() => setTab("book")}><Navigation size={14} /> Book</button>
              <button className={`lr-tab ${tab === "rides" ? "active" : ""}`} onClick={() => setTab("rides")}><Clock3 size={14} /> Rides</button>
              <button className={`lr-tab ${tab === "help" ? "active" : ""}`} onClick={() => setTab("help")}><CircleHelp size={14} /> Help</button>
            </nav>
            {tab === "book" && (
              <div>
                <div className="lr-intro">
                  <div>
                    <div className="lr-content-label">Your next move</div>
                    <h1 className="lr-title">Where to?</h1>
                  </div>
                  <span className="lr-stamp">NOW · 11:42</span>
                </div>
                <div className="lr-route-box">
                  <label className="lr-field pickup">
                    <span className="lr-field-icon"><LocateFixed size={14} /></span>
                    <input value={pickup} onChange={(event) => setPickup(event.target.value)} aria-label="Pickup location" />
                  </label>
                  <label className="lr-field dropoff">
                    <span className="lr-field-icon"><MapPin size={14} /></span>
                    <input value={dropoff} onChange={(event) => setDropoff(event.target.value)} aria-label="Drop-off location" />
                  </label>
                </div>
                <div className="lr-vehicle-scroll" aria-label="Choose a vehicle">
                  {vehicles.map((item, index) => (
                    <button key={item.name} className={`lr-vehicle ${vehicle === index ? "selected" : ""}`} onClick={() => setVehicle(index)}>
                      <CarFront size={16} /><strong>{item.name}</strong><span>{item.fare}</span>
                    </button>
                  ))}
                </div>
                <div className="lr-estimate">
                  <div className="lr-estimate-meta"><strong>Estimated trip</strong>6.8 km · about 21 min</div>
                  <div className="lr-fare">{vehicles[vehicle].fare}</div>
                </div>
                <div className="lr-payment">
                  <span className="lr-payment-main"><WalletCards size={14} /> Cash</span>
                  <button className="lr-change" onClick={() => notify("Payment options opened")}>Change</button>
                </div>
                <button className="lr-primary" onClick={() => setRequested(true)}>Request {vehicles[vehicle].name}<span aria-hidden="true">↗</span></button>
              </div>
            )}
            {tab === "rides" && (
              <div>
                <div className="lr-intro"><div><div className="lr-content-label">Your archive</div><h1 className="lr-title">Recent rides</h1></div><span className="lr-stamp">03 TRIPS</span></div>
                {histories.map(([from, to, fare, date]) => (
                  <button className="lr-history" key={`${from}-${to}`} onClick={() => notify(`${from} to ${to} selected`)}>
                    <MapPin className="lr-history-icon" size={15} />
                    <span className="lr-history-copy"><p>{from} <span aria-hidden="true">→</span> {to}</p><small>{date}</small></span>
                    <strong className="lr-history-fare">{fare}</strong>
                  </button>
                ))}
              </div>
            )}
            {tab === "help" && (
              <div>
                <div className="lr-intro"><div><div className="lr-content-label">Always nearby</div><h1 className="lr-title">Need a hand?</h1></div></div>
                <div className="lr-help-card">
                  <div className="lr-chip"><ShieldCheck size={13} /> You&apos;re covered</div>
                  <h3>Travel with a little more peace of mind.</h3>
                  <p>Reach a real person, check a safety guide, or share your live trip with a trusted contact.</p>
                  <button className="lr-primary" onClick={() => notify("Support request started")}>Contact support <span aria-hidden="true">↗</span></button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
      {toast && <div className="lr-toast" role="status">{toast}</div>}
    </main>
  );
}