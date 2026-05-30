import { Buffer } from 'node:buffer';
import type { RawData } from 'npm:@types/ws';
import { RealtimeClient } from '../realtime/client.js';
import { RealtimeUtils } from '../realtime/utils.js';
import { addConversation, getDeviceInfo } from '../supabase.ts';
import { createOpusPacketizer, defaultOpenAIVoice, isDev, openaiApiKey } from '../utils.ts';

// ── LIFESAVER / FIREBASE HELPERS ────────────────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyCnhFsE3JrCBljOHjDpF_d8msWuzEwCed4";
const FIRESTORE_BASE   = "https://firestore.googleapis.com/v1/projects/lifesaver-9e934/databases/(default)/documents";

/** Write a new document to a Firestore collection */
async function firestoreAdd(collection: string, fields: Record<string, unknown>): Promise<boolean> {
    try {
        const res = await fetch(`${FIRESTORE_BASE}/${collection}?key=${FIREBASE_API_KEY}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ fields }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error("Firestore write error:", err);
        }
        return res.ok;
    } catch (e) {
        console.error("Firestore add failed:", e);
        return false;
    }
}

/** Query donors with equality filters */
async function firestoreQuery(
    collection: string,
    filters: Array<{ field: string; value: unknown; kind: "string" | "boolean" }>,
    limit = 3,
): Promise<Array<{ name: string; phone: string; address: string; item: string }>> {
    try {
        const builtFilters = filters.map(f => ({
            fieldFilter: {
                field: { fieldPath: f.field },
                op:    "EQUAL",
                value: f.kind === "boolean" ? { booleanValue: f.value } : { stringValue: f.value },
            },
        }));

        const structuredQuery = {
            from:  [{ collectionId: collection }],
            where: builtFilters.length === 1
                ? builtFilters[0]
                : { compositeFilter: { op: "AND", filters: builtFilters } },
            limit,
        };

        const res = await fetch(`${FIRESTORE_BASE}:runQuery?key=${FIREBASE_API_KEY}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ structuredQuery }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error("Firestore query error:", errText);
            return [];
        }

        const rawJson = await res.json();
        console.log("Firestore raw response:", JSON.stringify(rawJson).slice(0, 500));
        const rows: unknown[] = rawJson as unknown[];
        
        return (rows as any[])
            .filter((r) => r.document)
            .map((r) => {
                const f = r.document.fields ?? {};
                return {
                    name:    f.name?.stringValue    ?? "Unknown",
                    phone:   f.phone?.stringValue   ?? "",
                    address: f.address?.stringValue ?? "",
                    item:    f.item?.stringValue    ?? "",
                };
            });
    } catch (e) {
        console.error("Firestore query failed:", e);
        return [];
    }
}
// ────────────────────────────────────────────────────────────────────────────

// ── TOOL DEFINITIONS (single source of truth) ─────────────────────────────
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        name: 'end_session',
        description: 'Call this if the user says bye or needs to leave.',
        parameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Short reason for ending the session.' } },
            required: ['reason'],
        },
    },
    {
        type: 'function',
        name: 'broadcast_sos',
        description: 'Broadcast an emergency SOS to the Lifesaver network for blood or medicine.',
        parameters: {
            type: 'object',
            properties: {
                item:     { type: 'string' },
                category: { type: 'string', enum: ['BLOOD', 'MEDICINE'] },
                hospital: { type: 'string' },
                urgency:  { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            },
            required: ['item', 'category', 'hospital', 'urgency'],
        },
    },
    {
        type: 'function',
        name: 'find_donors',
        description: 'Find available blood donors or medicine providers in the Lifesaver network.',
        parameters: {
            type: 'object',
            properties: {
                item:     { type: 'string' },
                category: { type: 'string', enum: ['BLOOD', 'MEDICINE'] },
            },
            required: ['item', 'category'],
        },
    },
] as const;

const LIFESAVER_INSTRUCTIONS = `You are LIFESAVER AI, an emergency response assistant for a blood and medicine donor network in Bengaluru, India.
Help find blood donors, medicine providers, and broadcast SOS alerts.
IMPORTANT: When calling a tool, do NOT speak before or during the tool call. Wait for the tool result, then speak ONLY the final answer. Never say "let me check". Just call the tool silently and respond with the result.
Keep responses under 2 sentences.`;

const sendFirstMessage = (client: RealtimeClient, firstMessage: string) => {
    const event = {
        event_id: RealtimeUtils.generateId('evt_'),
        type: 'conversation.item.create',
        previous_item_id: 'root',
        item: {
            type: 'message',
            role: 'system',
            content: [{
                type: 'input_text',
                text: firstMessage,
            }],
        },
    };

    client.realtime.send(event.type, event);
    client.realtime.send('response.create', {
        event_id: RealtimeUtils.generateId('evt_'),
        type: 'response.create',
    });
};

export const connectToOpenAI = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
    broadcastFn,
}: ProviderArgs) => {
    const { user, supabase } = payload;

    const opus = createOpusPacketizer((packet) => ws.send(packet));

    let currentItemId: string | null = null;
    let currentCallId: string | null = null;

    console.log(`Connecting with key "${openaiApiKey?.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: openaiApiKey });

    // ── TOOL: end_session ──────────────────────────────────────────────────
    client.addTool(
        TOOL_DEFINITIONS[0],
        (args: any) => {
            console.log('end session', args);
            ws.send(JSON.stringify({ type: 'server', msg: 'SESSION.END' }));
            return { success: true, message: `Session ended: ${args.reason}` };
        },
    );

    // ── TOOL: broadcast_sos ────────────────────────────────────────────────
    client.addTool(
        TOOL_DEFINITIONS[1],
        async (args: any) => {
            console.log('broadcast_sos called:', args);
            
            const normalizeItem = (raw: string) => {
                const s = raw.toUpperCase().trim();
                // Strip trailing words like "blood", "donors", "type"
                const cleaned = s.replace(/\b(BLOOD|DONORS?|TYPE|PROVIDER|MEDICINE)\b/g, '').trim();
                const wordMap: Record<string, string> = {
                    'O NEGATIVE': 'O-', 'O POSITIVE': 'O+',
                    'A NEGATIVE': 'A-', 'A POSITIVE': 'A+',
                    'B NEGATIVE': 'B-', 'B POSITIVE': 'B+',
                    'AB NEGATIVE': 'AB-', 'AB POSITIVE': 'AB+',
                };
                if (wordMap[cleaned]) return wordMap[cleaned];
                const symbolMatch = cleaned.match(/^(AB|A|B|O)[+-]$/);
                if (symbolMatch) return symbolMatch[0];
                return cleaned;
            };
            
            const item = normalizeItem(args.item);
            
            const ok = await firestoreAdd('emergency_requests', {
                itemNeeded:   { stringValue: item },
                category:     { stringValue: args.category },
                hospitalName: { stringValue: args.hospital },
                urgency:      { stringValue: args.urgency },
                source:       { stringValue: 'elato-voice' },
                timestamp:    { timestampValue: new Date().toISOString() },
            });
            if (ok) {
                return {
                    success: true,
                    message: `SOS broadcast sent for ${args.item} at ${args.hospital}. The Lifesaver network has been alerted.`,
                };
            }
            return { success: false, message: 'Failed to send SOS. Please try again.' };
        },
    );

    // ── TOOL: find_donors ──────────────────────────────────────────────────
    client.addTool(
        TOOL_DEFINITIONS[2],
        async (args: any) => {
            console.log('find_donors called:', args);
            
            // Normalize blood type — strip extra words, keep just e.g. "O+"
            const normalizeItem = (raw: string) => {
                const s = raw.toUpperCase().trim();
                // Strip trailing words like "blood", "donors", "type"
                const cleaned = s.replace(/\b(BLOOD|DONORS?|TYPE|PROVIDER|MEDICINE)\b/g, '').trim();
                const wordMap: Record<string, string> = {
                    'O NEGATIVE': 'O-', 'O POSITIVE': 'O+',
                    'A NEGATIVE': 'A-', 'A POSITIVE': 'A+',
                    'B NEGATIVE': 'B-', 'B POSITIVE': 'B+',
                    'AB NEGATIVE': 'AB-', 'AB POSITIVE': 'AB+',
                };
                if (wordMap[cleaned]) return wordMap[cleaned];
                const symbolMatch = cleaned.match(/^(AB|A|B|O)[+-]$/);
                if (symbolMatch) return symbolMatch[0];
                return cleaned;
            };
            
            const item = normalizeItem(args.item);
            console.log('normalized item:', item);

            // Query 1: new schema
            const newSchemaDonors = await firestoreQuery(
                'donors',
                [
                    { field: 'item',     value: item,          kind: 'string' },
                    { field: 'category', value: args.category, kind: 'string' },
                ],
                10,
            );

            // Query 2: old schema
            const oldSchemaDonors = await firestoreQuery(
                'donors',
                [
                    { field: 'bloodType', value: item, kind: 'string' },
                ],
                10,
            );

            console.log('newSchemaDonors:', JSON.stringify(newSchemaDonors));
            console.log('oldSchemaDonors:', JSON.stringify(oldSchemaDonors));

            // Merge, deduplicate by name+phone
            const seen = new Set<string>();
            const donors = [...newSchemaDonors, ...oldSchemaDonors].filter(d => {
                const key = `${d.name}${d.phone}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (donors.length === 0) {
                return {
                    found: 0,
                    message: `No ${item} donors found right now. I recommend broadcasting an SOS to alert the network.`,
                };
            }

            const summary = donors
                .map((d, i) => `${i + 1}. ${d.name} at ${d.address}, call ${d.phone}`)
                .join('. ');

            return {
                found:   donors.length,
                donors,
                message: `Found ${donors.length} donor${donors.length !== 1 ? 's' : ''}. ${summary}`,
            };
        },
    );

    // ── EVENT RELAY: OpenAI → Device ───────────────────────────────────────
    client.realtime.on('server.*', async (event: any) => {
     
        if (event.type === 'session.created') {
    console.log('session created', event);
    console.log('>>> LIFESAVER session.update firing now <<<');

    // Directly send raw session.update via realtime socket
    // bypassing the RealtimeClient wrapper entirely
    client.realtime.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
            instructions: LIFESAVER_INSTRUCTIONS,
            tool_choice: 'auto',
            tools: TOOL_DEFINITIONS,
            input_audio_transcription: {
                model: 'whisper-1',
                prompt: 'Lifesaver, blood donor, O positive, O negative, A positive, B negative, AB positive, plasma, medicine, insulin, SOS, broadcast, hospital, urgency, HIGH, MEDIUM, LOW, Bengaluru',
            },
        }
    }));

    sendFirstMessage(client, firstMessage);
} else if (event.type === 'session.updated') {
            console.log('session updated', event);
        } else if (event.type === 'error') {
            console.log('error', event);
        } else if (event.type === 'response.done') {
    console.log('response.done', event);
    const hasToolCall = event.response?.output?.some((o: any) => o.type === 'function_call');
    const hasNoAudio = event.response?.usage?.output_token_details?.audio_tokens === 0;
    opus.flush(true);
    if (!hasNoAudio && !hasToolCall) {
        ws.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
    }
        } else if (event.type === 'response.output_audio_transcript.done') {
            console.log('response.audio_transcript.done', event);
            console.log('broadcasting ai transcript, browserClients size:', (globalThis as any)._browserClientsSize);
            await addConversation(supabase, 'assistant', event.transcript, user);
            broadcastFn?.({ type: 'ai_transcript', text: event.transcript });
            console.log('broadcast sent:', event.transcript);
        } else if (event.type === 'input_audio_buffer.committed') {
            ws.send(JSON.stringify({ type: 'server', msg: 'AUDIO.COMMITTED' }));
        }

        if (event.type in client.conversation.EventProcessors) {
            try {
                switch (event.type) {
                    case 'response.created':
                        console.log('response.created', event);
                        opus.reset();
                        try {
                            const device = await getDeviceInfo(supabase, user.user_id);
                            if (device) {
                                ws.send(JSON.stringify({
                                    type: 'server',
                                    msg: 'RESPONSE.CREATED',
                                    volume_control: device.volume ?? 100,
                                }));
                            } else {
                                ws.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
                            }
                        } catch (error) {
                            console.error('Error fetching updated device info:', error);
                            ws.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
                        }
                        break;
                    case 'response.output_item.added':
                        console.log('response.output_item.added', event);
                        if (event.item.id) {
                            currentItemId = event.item.id;
                            currentCallId = event.item.call_id;
                        }
                        break;
                    case 'response.audio.delta':
                        break;
                    case 'conversation.item.created':
                        console.log('user said: ', event.item);
                        break;
                    case 'conversation.item.input_audio_transcription.completed':
                        console.log('user transcription:', event);
                        await addConversation(supabase, 'user', event.transcript, user);
                        broadcastFn?.({ type: 'user_transcript', text: event.transcript });
                        break;
                }
            } catch (error) {
                console.error('Error processing event:', error);
                console.error('Event that caused the error:', event);
                ws.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.ERROR' }));
            }
        }
    });

    client.realtime.on('server.response.output_audio.delta', (event: any) => {
        if (event.delta) {
            console.log('audio delta received, length:', event.delta.length);
            try {
                const pcmBuffer = Buffer.from(event.delta, 'base64');
                opus.push(pcmBuffer);
            } catch (e) {
                console.error('Error pushing audio to opus:', e);
            }
        }
    });

    client.realtime.on('close', () => ws.close());

    // ── EVENT RELAY: Device → OpenAI ───────────────────────────────────────
    const messageQueue: RawData[] = [];

    const messageHandler = async (data: any, isBinary: boolean) => {
        try {
            let event;
            if (isBinary) {
                const base64Data = data.toString('base64');
                event = {
                    event_id: RealtimeUtils.generateId('evt_'),
                    type: 'input_audio_buffer.append',
                    audio: base64Data,
                };
                if (isDev && connectionPcmFile) {
                    await connectionPcmFile.write(data);
                }
                client.realtime.send(event.type, event);
            } else {
                const message = JSON.parse(data.toString('utf-8'));
                if (message.type === 'instruction' && message.msg === 'end_of_speech') {
                    console.log('end_of_speech detected');
                    client.realtime.send('input_audio_buffer.commit', {
                        event_id: RealtimeUtils.generateId('evt_'),
                        type: 'input_audio_buffer.commit',
                    });
                    client.realtime.send('response.create', {
                        event_id: RealtimeUtils.generateId('evt_'),
                        type: 'response.create',
                    });
                    client.realtime.send('input_audio_buffer.clear', {
                        event_id: RealtimeUtils.generateId('evt_'),
                        type: 'input_audio_buffer.clear',
                    });
                } else if (message.type === 'instruction' && message.msg === 'INTERRUPT') {
                    console.log('interrupt detected', message);
                    const audioEndMs = message.audio_end_ms;
                    client.realtime.send('conversation.item.truncate', {
                        event_id: RealtimeUtils.generateId('evt_'),
                        type: 'conversation.item.truncate',
                        item_id: currentItemId,
                        content_index: 0,
                        audio_end_ms: audioEndMs,
                    });
                    client.realtime.send('input_audio_buffer.clear', {
                        event_id: RealtimeUtils.generateId('evt_'),
                        type: 'input_audio_buffer.clear',
                    });
                }
            }
        } catch (e: unknown) {
            console.error((e as Error).message);
            console.log(`Error parsing event from client: ${data}`);
        }
    };

    ws.on('message', (data: any, isBinary: boolean) => {
        if (!client.isConnected()) {
            messageQueue.push(data);
        } else {
            messageHandler(data, isBinary);
        }
    });

    ws.on('error', (error: any) => {
        console.error('WebSocket error:', error);
        client.disconnect();
    });

    ws.on('close', async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        client.disconnect();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log(`Closed debug audio file.`);
        }
    });

    // ── CONNECT ────────────────────────────────────────────────────────────
    try {
        console.log(`Connecting to OpenAI...`);

const sessionOptions = {
    model: 'gpt-realtime-2',
    turn_detection: {
        type: 'server_vad',
        threshold: 0.4,
        prefix_padding_ms: 400,
        silence_duration_ms: 1000,
    },
    voice: user.personality?.oai_voice ?? defaultOpenAIVoice,
    instructions: LIFESAVER_INSTRUCTIONS,
    input_audio_transcription: { 
    model: 'whisper-1',
    prompt: 'Lifesaver, blood donor, O positive, O negative, A positive, B negative, AB positive, plasma, medicine, insulin, SOS, broadcast, hospital, urgency, HIGH, MEDIUM, LOW, Bengaluru'
},
    tool_choice: 'auto',
    tools: TOOL_DEFINITIONS,
};
        await client.connect(sessionOptions as any);
    } catch (e: unknown) {
        console.log(`Error connecting to OpenAI: ${e as Error}`);
        ws.close();
        return;
    }

    console.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
        messageHandler(messageQueue.shift(), false);
    }
};