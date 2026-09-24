import {Router} from 'express';
import {db} from '../config/firebase.js';
import {requireAuth} from '../middleware/auth.js';
import {momoConfig, verifyMomoIpn} from '../services/momo.js';
import {settleContractPayment} from '../domain/contractPayments.js';
import {zaloConfig, verifyZaloCallback, validZaloTransaction} from '../services/zalopay.js';
import {refreshZaloPayment} from '../domain/zalopayPayments.js';

export const paymentsRouter = Router();
paymentsRouter.get('/zalopay/return', (_req, res) => {
  res.type('html').send('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TutorConnect</title><h1>Thanh toán ZaloPay sandbox</h1><p>Quay lại TutorConnect, mở Gói học của tôi và bấm Cập nhật trạng thái. Máy chủ sẽ xác minh kết quả thanh toán với ZaloPay.</p></html>');
});
paymentsRouter.post('/zalopay/callback', async (req, res) => {
  const config = zaloConfig();
  if (!config) { res.status(503).json({return_code: 2, return_message: 'Not configured'}); return; }
  if (config.verifyMode === 'query') {
    res.status(503).json({return_code: 2, return_message: 'Callback disabled; server query only'}); return;
  }
  if (!verifyZaloCallback(req.body || {}, config.key2)) {
    res.json({return_code: 2, return_message: 'Invalid MAC'}); return;
  }
  let data: Record<string, any>;
  try { data = JSON.parse(req.body.data); } catch { res.json({return_code: 2, return_message: 'Invalid data'}); return; }
  if (!data || data.app_id !== config.appId || typeof data.app_trans_id !== 'string' || !/^\d{6}_[a-f0-9]{24}$/.test(data.app_trans_id) || !Number.isSafeInteger(data.amount) || !validZaloTransaction(data.zp_trans_id)) {
    res.json({return_code: 2, return_message: 'Invalid transaction'}); return;
  }
  try {
    const order = (await db.collection('payment_orders').doc(data.app_trans_id).get()).data();
    if (!order || order.provider !== 'zalopay' || order.environment !== 'sandbox' || order.appId !== data.app_id || order.appUser !== data.app_user || order.amount !== data.amount) {
      res.json({return_code: 2, return_message: 'Order mismatch'}); return;
    }
    await settleContractPayment(data.app_trans_id, data.amount, String(data.zp_trans_id));
    res.json({return_code: 1, return_message: 'Success'});
  } catch {
    res.status(503).json({return_code: 2, return_message: 'Please retry'});
  }
});
paymentsRouter.get('/momo/return', (_req, res) => {
  res.type('html').send('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TutorConnect</title><h1>Đã quay lại từ MoMo Test</h1><p>Hãy quay lại ứng dụng TutorConnect, mở Gói học của tôi và cập nhật trạng thái. Kết quả thanh toán được xác nhận bởi máy chủ.</p></html>');
});
paymentsRouter.post('/momo/ipn', async (req, res) => {
  const config = momoConfig();
  if (!config) { res.sendStatus(503); return; }
  const body = req.body || {};
  if (!verifyMomoIpn(body, config)) { res.sendStatus(401); return; }
  if (typeof body.orderId !== 'string' || !/^TC-[a-f0-9-]{36}$/.test(body.orderId) || !Number.isSafeInteger(body.amount) || !Number.isInteger(body.resultCode)) {
    res.sendStatus(400); return;
  }
  const ref = db.collection('payment_orders').doc(body.orderId);
  const order = (await ref.get()).data();
  if (!order || order.provider !== 'momo' || order.environment !== 'sandbox' || order.requestId !== body.requestId || order.amount !== body.amount || order.orderInfo !== body.orderInfo) {
    res.sendStatus(400); return;
  }
  if (body.resultCode === 0) {
    if (!/^[1-9]\d*$/.test(String(body.transId)) || (typeof body.transId === 'number' && !Number.isSafeInteger(body.transId))) { res.sendStatus(400); return; }
    await settleContractPayment(body.orderId, body.amount, String(body.transId));
  } else {
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.status === 'paid' || current?.status === 'failed') return;
      const failed = [98, 99, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1017, 1026, 2019, 4001, 4002, 4100].includes(body.resultCode);
      tx.update(ref, {status: failed ? 'failed' : 'pending', resultCode: body.resultCode});
    });
  }
  res.status(204).end();
});
paymentsRouter.get('/:id', requireAuth, async (req, res) => {
  let order = (await db.collection('payment_orders').doc(String(req.params.id)).get()).data();
  if (!order || order.userId !== req.firebaseUser!.uid) { res.sendStatus(404); return; }
  if (order.provider === 'zalopay' && order.status === 'pending') {
    const config = zaloConfig();
    if (!config) { res.status(503).json({message: 'Chưa cấu hình ZaloPay sandbox.'}); return; }
    order = await refreshZaloPayment(String(req.params.id), config);
  }
  res.json({orderId: req.params.id, status: order.status, needsReview: order.needsReview === true});
});
