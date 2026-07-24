import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { handleInboundEmail } from './controllers/email.controller';
import { logger } from './utils/logger';
import './jobs/cron'; // Initializes standard polling

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/webhooks/email', handleInboundEmail);

app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});