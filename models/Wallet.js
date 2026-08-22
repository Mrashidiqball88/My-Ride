const mongoose = require('mongoose');

const TARGETS = {
  bike: 2500,
  rickshaw: 4000,
  car_mini: 5500,
  car_ac: 6500
};

const paymentSchema = new mongoose.Schema({
  trxId: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const walletSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  vehicleType: { type: String, enum: ['bike', 'rickshaw', 'car_mini', 'car_ac'], required: true },
  totalPaid: { type: Number, default: 0 },
  payments: [paymentSchema]
});

walletSchema.methods.getSummary = function() {
  const target = TARGETS[this.vehicleType] || 0;
  const remaining = Math.max(0, target - this.totalPaid);
  return {
    vehicleType: this.vehicleType,
    targetAmount: target,
    totalPaid: this.totalPaid,
    remainingBalance: remaining,
    isFullyPaid: remaining === 0
  };
};

module.exports = mongoose.model('Wallet