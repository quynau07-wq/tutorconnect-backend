import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

export function zaloConfig() {
  const appId = Number(process.env.ZALOPAY_APP_ID);
  const key1 = process.env.ZALOPAY_KEY1;
  const key2 = process.env.ZALOPAY_KEY2?.trim() || '';
  const verifyMode = process.env.ZALOPAY_VERIFY_MODE || 'callback';
  if (!['callback', 'query'].includes(verifyMode)) throw new Error('ZALOPAY_VERIFY_MODE phải là callback hoặc query.');
  const publicUrl = (process.env.ZALOPAY_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '');
  if (!appId || !key1 || (verifyMode === 'callback' && (!key2 || !publicUrl))) return null;
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('ZALOPAY_APP_ID không hợp lệ.');
  const url = publicUrl ? new URL(publicUrl) : null;
  if (url && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash))
    throw new Error('ZALOPAY_PUBLIC_URL phải là URL HTTPS công khai của backend.');
  return {appId, key1, key2, verifyMode,
    callbackUrl: verifyMode === 'callback' ? `${publicUrl}/api/payments/zalopay/callback` : '',
    redirectUrl: `${publicUrl || 'http://127.0.0.1:3000'}/api/payments/zalopay/return`};
}
export type ZaloConfig = NonNullable<ReturnType<typeof zaloConfig>>;
export const zaloMac = (data: string, key: string) => createHmac('sha256', key).update(data).digest('hex');
export function zaloOrderId(now = Date.now()) {
  const date = new Date(now + 7 * 3600000).toISOString().slice(2, 10).replace(/-/g, '');
  return `${date}_${randomBytes(12).toString('hex')}`;
}
export function verifyZaloCallback(body: Record<string, unknown>, key2: string) {
  if (!key2 || body.type !== 1 || typeof body.data !== 'string' || typeof body.mac !== 'string' || !/^[a-f0-9]{64}$/i.test(body.mac)) return false;
  return timingSafeEqual(Buffer.from(zaloMac(body.data, key2), 'hex'), Buffer.from(body.mac, 'hex'));
}
async function post(path: 'create' | 'query', body: Record<string, unknown>) {
  const response = await fetch(`https://sb-openapi.zalopay.vn/v2/${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(10000), body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Không kết nối được ZaloPay sandbox. Vui lòng thử lại.');
  return await response.json() as Record<string, any>;
}
export type ZaloOrder = {
  orderId: string; amount: number; appTime: number; appUser: string; appId: number;
  embedData: string; description: string; callbackUrl: string;
};
export async function createZaloPayment(order: ZaloOrder, config: ZaloConfig) {
  const body = {app_id: order.appId, app_trans_id: order.orderId, app_user: order.appUser,
    amount: order.amount, app_time: order.appTime, embed_data: order.embedData, item: '[]',
    description: order.description,
    ...(config.verifyMode === 'callback' && order.callbackUrl ? {callback_url: order.callbackUrl} : {}),
    bank_code: '', expire_duration_seconds: 900};
  const raw = `${body.app_id}|${body.app_trans_id}|${body.app_user}|${body.amount}|${body.app_time}|${body.embed_data}|${body.item}`;
  const result = await post('create', {...body, mac: zaloMac(raw, config.key1)});
  if (result.return_code !== 1) throw new Error(`ZaloPay chưa tạo được đơn (mã ${Number(result.sub_return_code) || 0}). Hãy kiểm tra cấu hình hoặc thử lại với cùng đơn.`);
  const url = new URL(result.order_url);
  if (url.protocol !== 'https:' || !['sbgateway.zalopay.vn', 'sbqr.zalopay.vn', 'qcgateway.zalopay.vn'].includes(url.hostname) || url.username || url.password || url.port)
    throw new Error('URL thanh toán ZaloPay sandbox không hợp lệ.');
  return url.toString();
}
export async function queryZaloPayment(orderId: string, config: ZaloConfig) {
  return post('query', {app_id: config.appId, app_trans_id: orderId,
    mac: zaloMac(`${config.appId}|${orderId}|${config.key1}`, config.key1)});
}
export function validZaloTransaction(value: unknown) {
  return (typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}
