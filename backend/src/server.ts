import 'dotenv/config';
import {app} from './app.js';
import {startNotificationWorker} from './notificationWorker.js';
import {startPaymentWorker} from './paymentWorker.js';

const port = Number(process.env.PORT || 3000);

app.listen(port, '0.0.0.0', () => {
  startNotificationWorker();
  startPaymentWorker();
  console.log(`TutorConnect backend listening on port ${port}`);
});
