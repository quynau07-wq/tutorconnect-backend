import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import meRouter from './routes/me.js';
import adminRouter from './routes/admin.js';
import {profileRouter} from './routes/profile.js';
import {learningRouter} from './routes/learning.js';
import {contractsRouter} from './routes/contracts.js';
import {lessonScheduleRouter} from './routes/lessonSchedule.js';
import {operationsRouter} from './routes/operations.js';
import {notificationsRouter} from './routes/notifications.js';
import {paymentsRouter} from './routes/payments.js';

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({limit: '2mb'}));

app.get('/health', (_request, response) => {
  response.json({status: 'ok', service: 'tutorconnect-backend'});
});

app.use('/api/me', meRouter);
app.use('/api/admin', adminRouter);
app.use('/api/profile', profileRouter);
app.use('/api/learning', learningRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/schedule', lessonScheduleRouter);
app.use('/api/operations', operationsRouter);
app.use('/api/notifications', notificationsRouter);
app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(400).json({message: error.message || 'Không thể thực hiện yêu cầu.'});
});
