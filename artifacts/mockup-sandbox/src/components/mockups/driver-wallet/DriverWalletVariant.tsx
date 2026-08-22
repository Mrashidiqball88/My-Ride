import React, { useState } from "react";

type Payment = { id: string; amount: string; status: "Under review" | "Approved"; date: string };

export default function DriverWalletVariant() {
  const [trxId, setTrxId] = useState("");
  const [amount, setAmount] = useState("");
  const [notice, setNotice] = useState("");
  const [payments, setPayments] = useState<Payment[]>([
    { id: "8F2A · 4910", amount: "2,500", status: "Approved", date: "Today, 08:42" },
    { id: "4C91 · 2703", amount: "2,500", status: "Approved", date: "Yesterday" },
  ]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trxId.trim() || !amount.trim()) {
      setNotice("Add the transaction ID and amount to continue.");
      return;
    }
    setPayments((current) => [
      { id: trxId.slice(0, 4).toUpperCase() + " · " + trxId.slice(-4), amount: Number(amount).toLocaleString(), status: "Under review", date: "Just now" },
      ...current,
    ]);
    setTrxId("");
    setAmount("");
    setNotice("Payment received. We’ll review it shortly.");
  }

  return (
    <main className="dwv-shell" dir="rtl">
      <style>{`
        .dwv-shell{--ink:#1f2933;--muted:#7c817d;--paper:#f7f3ea;--cream:#fcfaf5;--line:#e7dfd2;--saffron:#d88832;--sage:#758b70;min-height:100vh;background:var(--paper);color:var(--ink);font-family:Georgia,'Times New Roman',serif;display:flex;justify-content:center;padding:44px 22px}
        .dwv-wrap{width:min(100%,960px);direction:rtl}
        .dwv-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:42px}
        .dwv-brand{display:flex;gap:12px;align-items:center;direction:ltr}
        .dwv-mark{height:40px;width:40px;border-radius:50%;background:var(--saffron);display:grid;place-items:center;color:var(--cream);font-size:19px;font-weight:bold;box-shadow:4px 5px 0 #ead4b6}
        .dwv-brand strong{display:block;font:700 15px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}
        .dwv-brand small{font:11px ui-sans-serif,system-ui,sans-serif;color:var(--muted);letter-spacing:.08em}
        .dwv-greeting{text-align:right}
        .dwv-greeting p{font:11px ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin:0 0 5px}
        .dwv-greeting h1{font-size:27px;line-height:1.15;margin:0;font-weight:500;letter-spacing:-.03em}
        .dwv-layout{display:grid;grid-template-columns:1.35fr 1fr;gap:22px;direction:ltr}
        .dwv-card,.dwv-form,.dwv-history{background:var(--cream);border:1px solid var(--line);border-radius:18px}
        .dwv-card{min-height:284px;padding:26px;display:flex;flex-direction:column;justify-content:space-between;direction:rtl;position:relative;overflow:hidden;background:#273c45;color:#f7f3ea;border-color:#273c45}
        .dwv-card:after{content:"";position:absolute;width:210px;height:210px;border:1px solid rgba(240,207,165,.3);border-radius:50%;left:-70px;bottom:-110px}
        .dwv-card-top{display:flex;justify-content:space-between;align-items:center;font:11px ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;color:#d9d4c9}
        .dwv-chip{width:33px;height:24px;border:1px solid #d4b47d;border-radius:5px;opacity:.8}
        .dwv-balance-label{font:11px ui-sans-serif,system-ui,sans-serif;color:#b8c3bd;margin-bottom:8px}
        .dwv-balance{font-size:43px;font-weight:500;letter-spacing:-.04em;margin:0}
        .dwv-balance span{font:14px ui-sans-serif,system-ui,sans-serif;color:#d7c29d;margin-right:8px;letter-spacing:.08em}
        .dwv-card-foot{display:flex;justify-content:space-between;align-items:end;font:11px ui-sans-serif,system-ui,sans-serif;color:#c2cdc5}
        .dwv-active{display:flex;gap:7px;align-items:center}.dwv-dot{height:7px;width:7px;background:#d9a261;border-radius:50%}
        .dwv-form{padding:25px;direction:rtl}
        .dwv-kicker{font:10px ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;color:var(--saffron);margin:0 0 9px}
        .dwv-form h2{font-size:22px;font-weight:500;margin:0 0 22px;letter-spacing:-.025em}
        .dwv-field{margin-bottom:15px}.dwv-field label{display:block;font:11px ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin:0 0 7px}
        .dwv-field input{box-sizing:border-box;width:100%;border:1px solid var(--line);background:#faf8f2;border-radius:9px;padding:12px 13px;font:14px ui-sans-serif,system-ui,sans-serif;color:var(--ink);outline:none;transition:border-color .2s}
        .dwv-field input:focus{border-color:var(--saffron)}
        .dwv-submit{width:100%;border:0;border-radius:9px;background:var(--saffron);color:#fffaf2;padding:13px;font:700 12px ui-sans-serif,system-ui,sans-serif;cursor:pointer;letter-spacing:.02em;transition:transform .2s,background .2s}
        .dwv-submit:hover{background:#bd7026;transform:translateY(-1px)}.dwv-notice{font:11px ui-sans-serif,system-ui,sans-serif;color:var(--sage);margin:10px 0 0;min-height:15px}
        .dwv-history{grid-column:1 / -1;padding:24px;direction:rtl}
        .dwv-history-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:18px}.dwv-history h2{font-size:20px;font-weight:500;margin:0}.dwv-history-head span{font:10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;color:var(--muted)}
        .dwv-row{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;align-items:center;border-top:1px solid var(--line);padding:15px 0;font:12px ui-sans-serif,system-ui,sans-serif}
        .dwv-row.head{color:var(--muted);font-size:10px;padding-top:0;border-top:0}.dwv-row .id{font-family:ui-monospace,monospace;letter-spacing:.06em;color:#55615e}.dwv-status{display:inline-flex;justify-self:start;padding:5px 9px;border-radius:99px;background:#edf1e9;color:#65775f;font-size:10px}.dwv-status.review{background:#f7ebd9;color:#a96a2c}
        @media(max-width:700px){.dwv-shell{padding:25px 16px}.dwv-top{margin-bottom:28px}.dwv-layout{grid-template-columns:1fr;gap:14px}.dwv-history{grid-column:auto}.dwv-card{min-height:235px}.dwv-row{grid-template-columns:1.2fr 1fr 1fr}.dwv-row>*:last-child{display:none}}
      `}</style>
      <div className="dwv-wrap">
        <header className="dwv-top">
          <div className="dwv-brand"><div className="dwv-mark">م</div><div><strong>Raasta</strong><small>driver account</small></div></div>
          <div className="dwv-greeting"><p>خوش آمدید، علی</p><h1>آپ کا والٹ</h1></div>
        </header>
        <section className="dwv-layout">
          <article className="dwv-card">
            <div className="dwv-card-top"><span>RAASTA / WALLET</span><span className="dwv-chip" /></div>
            <div><div className="dwv-balance-label">موجودہ بیلنس</div><p className="dwv-balance">2,500 <span>PKR</span></p></div>
            <div className="dwv-card-foot"><span className="dwv-active"><i className="dwv-dot" /> Active account</span><span>•••• 4281</span></div>
          </article>
          <form className="dwv-form" onSubmit={handleSubmit}>
            <p className="dwv-kicker">Daily access fee</p><h2>ادائیگی جمع کریں</h2>
            <div className="dwv-field"><label htmlFor="trx">TRX ID</label><input id="trx" value={trxId} onChange={(e) => setTrxId(e.target.value)} placeholder="مثال: 8492048291" /></div>
            <div className="dwv-field"><label htmlFor="amount">رقم (PKR)</label><input id="amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="مثال: 2500" /></div>
            <button className="dwv-submit" type="submit">ادائیگی جمع کریں　→</button><p className="dwv-notice">{notice}</p>
          </form>
          <section className="dwv-history"><div className="dwv-history-head"><h2>حالیہ ادائیگیاں</h2><span>PAYMENT HISTORY</span></div><div className="dwv-row head"><span>Transaction</span><span>Amount</span><span>Status</span><span>Date</span></div>{payments.map((payment) => <div className="dwv-row" key={payment.id + payment.date}><span className="id">{payment.id}</span><span>{payment.amount} PKR</span><span><b className={"dwv-status " + (payment.status === "Under review" ? "review" : "")}>{payment.status}</b></span><span>{payment.date}</span></div>)}</section>
        </section>
      </div>
    </main>
  );
}