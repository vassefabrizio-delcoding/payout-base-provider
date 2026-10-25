/**
 * DELCODING EMI CORE-BANKING PLATFORM
 * PRODUCTION ENTERPRISE SERVER ENTRY POINT
 * 
 * Runs on Node.js 22 with TypeScript, zero .env dependencies,
 * integrated AES-256-GCM In-Memory Vault, multi-chain Blockchain Network Manager,
 * ISO 20022 interbank clearing engine, and local AML screening.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Import production V2 TypeScript API router
import productionRoutes from './routes/productionRoutes.js';

// Import existing routes for dashboard compatibility
// @ts-ignore
import platformRoutes from './routes/platform.js';
// @ts-ignore
import complianceRoutes from './routes/compliance.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static asset delivery
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

// Mount Production V2 Enterprise API Router
app.use('/api/v2', productionRoutes);

// Mount Platform & Admin Compatibility API routes
app.use('/api/platform', platformRoutes);
app.use('/api/admin', complianceRoutes);
app.use('/api', platformRoutes); // Backward compatibility root

// SPA / Dashboard Fallback Route
app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.accepts('html')) {
        res.sendFile(path.join(publicDir, 'index.html'));
    } else {
        next();
    }
});

// Centralized Enterprise Error Handler with PII redaction
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    const sanitizedMessage = (err.message || 'Errore interno del gateway')
        .replace(/0x[a-fA-F0-9]{40}/g, '[REDACTED_ADDRESS]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');

    console.error('[CORE GATEWAY ERROR]', sanitizedMessage);
    res.status(500).json({
        success: false,
        error: sanitizedMessage,
        timestamp: new Date().toISOString()
    });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
    console.log(`================================================================`);
    console.log(`[DELCODING EMI GATEWAY] Production Server operational on http://${HOST}:${PORT}`);
    console.log(`[MODULE 1] Multi-Chain Blockchain Network Manager (Ethers v6 & EIP-1559) active.`);
    console.log(`[MODULE 2] ISO 20022 Interbank Clearing Engine (pacs.008/004, camt.053) active.`);
    console.log(`[MODULE 3] Self-Secured In-Memory Vault (AES-256-GCM / Zero .ENV) active.`);
    console.log(`[MODULE 4] Autonomous Local AML & Sanctions Screening Engine active.`);
    console.log(`================================================================`);
});

export default app;
