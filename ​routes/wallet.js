const express = require('express');
const router = express.Router();
const Wallet = require('../models/Wallet');

router.post('/submit-payment', async (req, res) => {
  try {
    const { driverId, vehicleType, trxId, amount } = req.body;
    let wallet = await Wallet.findOne({ driverId });
    if (!wallet) wallet = new Wallet({ driverId, vehicleType });
    wallet.payments.push({ trxId, amount, status: 'pending' });
    await wallet.save();
    res.status(200).json({ message: 'Payment submitted successfully', summary: wallet.getSummary() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/pending-payments', async (req, res) => {
  try {
    const wallets = await Wallet.find({ 'payments.status': 'pending' }).populate('driverId', 'name phone');
    const pendingList = [];
    wallets.forEach(w => {
      w.payments.filter(p => p.status === 'pending').forEach(p => {
        pendingList.push({
          walletId: w._id,
          paymentId: p._id,
          driverName: w.driverId ? w.driverId.name : 'Unknown',
          driverPhone: w.driverId ? w.driverId.phone : '',
          trxId: p.trxId,
          amount: p.amount,
          date: p.createdAt
        });
      });
    });
    res.status(200).json(pendingList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/approve-payment', async (req, res) => {
  try {
    const { walletId, paymentId } = req.body;
    const wallet = await Wallet.findById(walletId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const payment = wallet.payments.id(paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment record not found' });
    if (payment.status === 'pending') {
      payment.status = 'approved';
      wallet.totalPaid += payment.amount;
      await wallet.save();
    }
    res.status(200).json({ message: 'Payment approved successfully', summary: wallet.getSummary() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
