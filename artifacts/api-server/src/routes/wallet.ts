import { Router } from 'express';

const router = Router();

router.post('/submit-payment', (req, res) => {
  try {
    const { driverId, trxId, amount, vehicleType } = req.body;

    if (!trxId || !amount) {
      return res.status(400).json({ error: 'TRX ID اور رقم درج کریں' });
    }

    return res.status(200).json({
      success: true,
      message: 'پیمنٹ کی درخواست موصول ہو گئی ہے',
      data: { driverId, trxId, amount, vehicleType, status: 'Pending' }
    });
  } catch (error) {
    return res.status(500).json({ error: 'سرور میں مسئلہ آ گیا ہے' });
  }
});

export default router;
