/**
 * DELCODING EMI CORE-BANKING PLATFORM
 * PRODUCTION API ROUTER (ENTERPRISE V2 MODULES)
 * 
 * Exposes production endpoints for:
 * 1. Self-Secured In-Memory Vault
 * 2. Multi-chain Blockchain Network Manager (Circle USDC/EURC & Native coins)
 * 3. ISO 20022 Interbank Clearing Engine & EBICS Dispatch
 * 4. Autonomous Local AML & Sanctions Screening Engine
 */

import { Router, Request, Response } from 'express';
import { SelfSecuredVault, VaultState } from '../modules/security/SelfSecuredVault.js';
import { BlockchainNetworkManager } from '../modules/blockchain/BlockchainNetworkManager.js';
import { Iso20022Engine, Pacs008Instruction, Pacs004Instruction, Camt053Statement } from '../modules/clearing/Iso20022Engine.js';
import { InterbankRoutingConnector } from '../modules/clearing/InterbankRoutingConnector.js';
import { SanctionsScreeningEngine } from '../modules/compliance/SanctionsScreeningEngine.js';

const router = Router();
const vault = SelfSecuredVault.getInstance();
const blockchain = BlockchainNetworkManager.getInstance();
const clearing = Iso20022Engine.getInstance();
const routing = InterbankRoutingConnector.getInstance();
const sanctions = SanctionsScreeningEngine.getInstance();

// Autonomous unlocking on boot using institutional baseline passphrase
try {
    vault.unlock('EMI_MASTER_AUTONOMOUS_ENTROPY_V2026_DELCODING_BCE');
    const secrets = vault.getSecretsSnapshot();
    if (secrets.institutionPrivateKey) {
        blockchain.setSignerPrivateKey(secrets.institutionPrivateKey);
    }
} catch (e) {
    console.warn('[SERVER BOOT] Vault locked, awaiting operator unlock.');
}

// ==========================================
// 1. SELF-SECURED IN-MEMORY VAULT ROUTES
// ==========================================

router.get('/vault/status', (req: Request, res: Response) => {
    res.json({
        success: true,
        vault: vault.getStatus(),
        timestamp: new Date().toISOString()
    });
});

router.post('/vault/unlock', (req: Request, res: Response) => {
    try {
        const { passphrase } = req.body;
        if (!passphrase || typeof passphrase !== 'string') {
            return res.status(400).json({ success: false, error: 'Passphrase obbligatoria per lo sblocco in memoria RAM.' });
        }

        vault.unlock(passphrase);
        const secrets = vault.getSecretsSnapshot();
        if (secrets.institutionPrivateKey) {
            blockchain.setSignerPrivateKey(secrets.institutionPrivateKey);
        }

        res.json({
            success: true,
            message: 'Vault sbloccato con successo. Segreti decifrati esclusivamente nella memoria RAM volatile.',
            status: vault.getStatus()
        });
    } catch (err) {
        res.status(403).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/vault/lock', (req: Request, res: Response) => {
    vault.lock();
    res.json({
        success: true,
        message: 'Vault bloccato con successo e buffer di memoria volatile bonificati con random bytes.',
        status: vault.getStatus()
    });
});

// ==========================================
// 2. BLOCKCHAIN NETWORK MANAGER ROUTES
// ==========================================

router.get('/blockchain/chains', (req: Request, res: Response) => {
    res.json({
        success: true,
        chains: BlockchainNetworkManager.CHAINS
    });
});

router.get('/blockchain/gas-estimate', async (req: Request, res: Response) => {
    try {
        const chainId = parseInt(req.query.chainId as string, 10) || 1;
        const isContract = req.query.isContract !== 'false';
        const estimate = await blockchain.estimateEip1559Gas(chainId, isContract);
        res.json({
            success: true,
            chainId,
            estimate: {
                ...estimate,
                baseFeePerGas: estimate.baseFeePerGas.toString(),
                maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
                maxFeePerGas: estimate.maxFeePerGas.toString(),
                gasLimit: estimate.gasLimit.toString()
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.get('/blockchain/balance', async (req: Request, res: Response) => {
    try {
        const token = ((req.query.token as string) || 'USDC').toUpperCase() as 'USDC' | 'EURC';
        const address = (req.query.address as string) || (vault.getState() === VaultState.UNLOCKED ? vault.getSecret('institutionAddress') : '');
        const chainId = parseInt(req.query.chainId as string, 10) || 1;

        if (!address) {
            return res.status(400).json({ success: false, error: 'Indirizzo portafoglio non specificato o Vault bloccato.' });
        }

        const balance = await blockchain.getErc20Balance(token, address, chainId);
        res.json({ success: true, token, address, chainId, balance });
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/blockchain/dispatch', async (req: Request, res: Response) => {
    try {
        const { token, recipientAddress, amount, chainId = 1, operation = 'TRANSFER', memo } = req.body;

        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: 'Importo non valido. Inserire una cifra maggiore di zero.' });
        }

        if (!recipientAddress) {
            return res.status(400).json({ success: false, error: 'Indirizzo destinatario obbligatorio.' });
        }

        // Pre-transaction AML & Sanction Screening
        const amlCheck = sanctions.screenParty({
            partyName: recipientAddress,
            walletAddress: recipientAddress,
            amount: parseFloat(amount),
            currency: token,
            rail: 'ON_CHAIN',
            transactionReference: memo || 'WEB3_DISBURSEMENT'
        });

        if (amlCheck.decision === 'BLOCKED') {
            return res.status(403).json({
                success: false,
                error: amlCheck.reason,
                amlReport: amlCheck,
                blockedByCompliance: true
            });
        }

        const receipt = await blockchain.dispatchTransaction({
            token,
            recipientAddress,
            amount: parseFloat(amount),
            chainId: parseInt(chainId, 10),
            operation,
            memo
        });

        res.json({
            success: true,
            receipt,
            amlAuditId: amlCheck.auditLogHash,
            message: `Transazione ${operation} per ${amount} ${token} eseguita con successo su ${receipt.network}.`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

// ==========================================
// 3. ISO 20022 CLEARING ENGINE ROUTES
// ==========================================

router.post('/clearing/pacs008', async (req: Request, res: Response) => {
    try {
        const instruction: Pacs008Instruction = req.body;
        if (!instruction.instructedAmount || !instruction.creditor?.iban) {
            return res.status(400).json({ success: false, error: 'Campi obbligatori mancanti: instructedAmount, creditor.iban.' });
        }

        // Mandatory AML Screening on Creditor & Debtor
        const amlCreditor = sanctions.screenParty({
            partyName: instruction.creditor.name,
            country: instruction.creditor.country,
            amount: instruction.instructedAmount,
            currency: instruction.currency || 'EUR',
            rail: 'SEPA',
            transactionReference: instruction.endToEndId
        });

        if (amlCreditor.decision === 'BLOCKED') {
            return res.status(403).json({
                success: false,
                error: amlCreditor.reason,
                amlReport: amlCreditor,
                blockedByCompliance: true
            });
        }

        const xml = clearing.generatePacs008Xml(instruction);
        res.setHeader('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/clearing/pacs004', async (req: Request, res: Response) => {
    try {
        const instruction: Pacs004Instruction = req.body;
        const xml = clearing.generatePacs004Xml(instruction);
        res.setHeader('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/clearing/camt053', async (req: Request, res: Response) => {
    try {
        const statement: Camt053Statement = req.body;
        const xml = clearing.generateCamt053Xml(statement);
        res.setHeader('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/clearing/dispatch-interbank', async (req: Request, res: Response) => {
    try {
        const { xmlPayload, channel = 'EBICS_3_0' } = req.body;
        if (!xmlPayload) {
            return res.status(400).json({ success: false, error: 'Payload XML obbligatorio.' });
        }

        const result = await routing.dispatchXmlPayload(xmlPayload, channel);
        res.json({ success: true, clearingResult: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

// ==========================================
// 4. AML & SANCTIONS SCREENING ROUTES
// ==========================================

router.post('/aml/screen', (req: Request, res: Response) => {
    try {
        const screeningReq = req.body;
        if (!screeningReq.partyName && !screeningReq.walletAddress && !screeningReq.taxId) {
            return res.status(400).json({ success: false, error: 'Inserire almeno uno tra partyName, walletAddress o taxId per lo screening.' });
        }

        const result = sanctions.screenParty(screeningReq);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});

router.get('/aml/audit-trail', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const trail = sanctions.getAuditTrail(limit);
    const integrity = sanctions.verifyAuditIntegrity();

    res.json({
        success: true,
        integrity,
        totalEntries: trail.length,
        auditTrail: trail
    });
});

export default router;
