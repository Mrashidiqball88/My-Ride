import React, { useState } from 'react';

export default function DriverWalletScreen() {
  const [trxId, setTrxId] = useState('');
  const [amount, setAmount] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trxId || !amount) {
      alert("براہ کرم TRX ID اور رقم درج کریں");
      return;
    }

    try {
      const res = await fetch('https://node-server--mrashidiqbal88.replit.app/api/wallet/submit-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId: "DRIVER_123",
          trxId: trxId,
          amount: Number(amount),
          vehicleType: "Bike"
        })
      });

      if (res.ok) {
        alert("آپ کی پیمنٹ کی درخواست جمع ہو گئی ہے!");
        setTrxId('');
        setAmount('');
      } else {
        alert("پیمنٹ جمع نہیں ہو سکی");
      }
    } catch (err) {
      alert("سرور سے رابطہ نہیں ہو سکا");
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '400px', margin: '0 auto', color: '#fff' }}>
      <h2 style={{ textAlign: 'center' }}>ڈرائیور والٹ</h2>
      
      <div style={{ background: '#1e293b', padding: '15px', borderRadius: '8px', marginBottom: '15px' }}>
        <p style={{ margin: 0, opacity: 0.8, fontSize: '12px' }}>موجودہ والٹ بیلنس</p>
        <h1 style={{ margin: '5px 0', fontSize: '28px' }}>2,500 PKR</h1>
        <p style={{ margin: 0, color: '#85d685', fontSize: '12px' }}>اسٹیٹس: Active</p>
      </div>

      <form onSubmit={handleSubmit} style={{ background: '#fff', color: '#333', padding: '15px', borderRadius: '8px' }}>
        <h4 style={{ margin: '0 0 10px 0' }}>روزانہ کی فیس (TRX ID) جمع کریں</h4>
        
        <label style={{ fontSize: '12px' }}>TRX ID:</label>
        <input 
          type="text" 
          value={trxId} 
          onChange={(e) => setTrxId(e.target.value)} 
          placeholder="مثال: 8492048291"
          style={{ width: '100%', padding: '8px', marginTop: '4px', marginBottom: '10px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
        />

        <label style={{ fontSize: '12px' }}>رقم (PKR):</label>
        <input 
          type="number" 
          value={amount} 
          onChange={(e) => setAmount(e.target.value)} 
          placeholder="مثال: 2500"
          style={{ width: '100%', padding: '8px', marginTop: '4px', marginBottom: '10px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
        />

        <button type="submit" style={{ width: '100%', background: '#16a34a', color: '#fff', border: 'none', padding: '10px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
          پیمنٹ سبمٹ کریں
        </button>
      </form>
    </div>
  );
}
