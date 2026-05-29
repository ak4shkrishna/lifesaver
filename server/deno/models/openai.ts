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
            console.error("Firestore query error:", await res.text());
            return [];
        }

        const rows: unknown[] = await res.json();
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
}: ProviderArgs) => {
    const { user, supabase } = payload;

    const opus = createOpusPacketizer((packet) => ws.send(packet));

    let currentItemId: string | null = null;
    let currentCallId: string | null = null;

    console.log(`Connecting with key "${openaiApiKey?.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: openaiApiKey });

    // ── TOOL: end_session ──────────────────────────────────────────────────
    client.addTool(
        {
            type: 'function',
            name: 'end_session',
            description:
                'Call this if the user says bye or needs to leave or suggests they want to end the session. (e.g. "I gotta to go", "I have to work", "I have to sleep", "I have to do something else")',
            parameters: {
                type: 'object',
                strict: true,
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Short reason for ending the session.',
                    },
                },
                required: ['reason'],
            },
        },
        (args: any) => {
            console.log('end session', args);
            ws.send(JSON.stringify({ type: 'server', msg: 'SESSION.END' }));
            return { success: true, message: `Session ended: ${args.reason}` };
        },
    );

    // ── TOOL: broadcast_sos ────────────────────────────────────────────────
    client.addTool(
        {
            type: 'function',
            name: 'broadcast_sos',
            description:
                'Broadcast an emergency SOS to the Lifesaver network when someone urgently needs blood or medicine. ' +
                'Use when the user says things like "we need O positive", "broadcast emergency for insulin", ' +
                '"send SOS for B negative blood", "alert donors for Type 2 insulin".',
            parameters: {
                type: 'object',
                strict: true,
                properties: {
                    item: {
                        type: 'string',
                        description: 'Blood type (e.g. O+, B-, AB+) or medicine name (e.g. Insulin, Anti-Venom)',
                    },
                    category: {
                        type: 'string',
                        enum: ['BLOOD', 'MEDICINE'],
                        description: 'Whether this is a blood or medicine emergency',
                    },
                    hospital: {
                        type: 'string',
                        description: 'Hospital or location name where blood/medicine is needed',
                    },
                    urgency: {
                        type: 'string',
                        enum: ['HIGH', 'MEDIUM', 'LOW'],
                        description: 'Urgency level of the emergency',
                    },
                },
                required: ['item', 'category', 'hospital', 'urgency'],
            },
        },
        async (args: any) => {
            console.log('broadcast_sos called:', args);
            const ok = await firestoreAdd('emergency_requests', {
                itemNeeded:   { stringValue: args.item.toUpperCase() },
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
        {
            type: 'function',
            name: 'find_donors',
            description:
                'Find available blood donors or medicine providers registered in the Lifesaver network. ' +
                'Use when the user asks "who has O negative blood", "find donors for insulin", ' +
                '"are there any B positive donors nearby", "check medicine availability".',
            parameters: {
                type: 'object',
                strict: true,
                properties: {
                    item: {
                        type: 'string',
                        description: 'Blood type (e.g. O+, B-) or medicine name to search for',
                    },
                    category: {
                        type: 'string',
                        enum: ['BLOOD', 'MEDICINE'],
                        description: 'Whether to search for blood donors or medicine providers',
                    },
                },
                required: ['item', 'category'],
            },
        },
        async (args: any) => {
            console.log('find_donors called:', args);
            const donors = await firestoreQuery(
                'donors',
                [
                    { field: 'item',       value: args.item.toUpperCase(), kind: 'string'  },
                    { field: 'category',   value: args.category,           kind: 'string'  },
                    { field: 'isEligible', value: true,                    kind: 'boolean' },
                ],
                3,
            );

            if (donors.length === 0) {
                return {
                    found: 0,
                    message: `No ${args.item} donors found right now. I recommend broadcasting an SOS to alert the network.`,
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
            instructions: `You are LIFESAVER AI, an emergency response assistant for a blood and medicine donor network in Bengaluru, India.
Help find blood donors, medicine providers, and broadcast SOS alerts.
IMPORTANT: When calling a tool, do NOT speak before or during the tool call. Wait for the tool result, then speak ONLY the final answer with the result. Never say "let me check" or "one moment". Just call the tool silently and respond with the result directly.
Keep responses under 2 sentences.
Start by saying: Lifesaver online. How can I help?`,
            tool_choice: 'auto',
           
            tools: [
                {
                    type: 'function',
                    name: 'end_session',
                    description: 'Call when user wants to end the session.',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: { type: 'string' }
                        },
                        required: ['reason']
                    }
                },
                {
                    type: 'function',
                    name: 'broadcast_sos',
                    description: 'Broadcast emergency SOS for blood or medicine to the Lifesaver network.',
                    parameters: {
                        type: 'object',
                        properties: {
                            item:     { type: 'string' },
                            category: { type: 'string', enum: ['BLOOD', 'MEDICINE'] },
                            hospital: { type: 'string' },
                            urgency:  { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] }
                        },
                        required: ['item', 'category', 'hospital', 'urgency']
                    }
                },
                {
                    type: 'function',
                    name: 'find_donors',
                    description: 'Find blood donors or medicine providers in the Lifesaver network.',
                    parameters: {
                        type: 'object',
                        properties: {
                            item:     { type: 'string' },
                            category: { type: 'string', enum: ['BLOOD', 'MEDICINE'] }
                        },
                        required: ['item', 'category']
                    }
                }
            ]
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
        } else if (event.type === 'response.audio_transcript.done') {
            console.log('response.audio_transcript.done', event);
            await addConversation(supabase, 'assistant', event.transcript, user);
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
            const lifesaverInstructions = `You are LIFESAVER AI, an emergency response assistant for a blood and medicine donor network in Bengaluru, India.
You help hospital staff and citizens with:
- Finding blood donors by blood type (say "find O positive donors")
- Finding medicine providers (say "find insulin providers")
- Broadcasting emergency SOS alerts (say "broadcast SOS for O negative blood at City Hospital high urgency")
Always be calm, fast and clear. Keep responses under 2 sentences since this is a voice device.
Start every session by saying: Lifesaver online. How can I help?`;

const sessionOptions = {
    model: 'gpt-realtime-2',
    turn_detection: {
        type: 'server_vad',
        threshold: 0.4,
        prefix_padding_ms: 400,
        silence_duration_ms: 1000,
    },
    voice: user.personality?.oai_voice ?? defaultOpenAIVoice,
    instructions: lifesaverInstructions,
    input_audio_transcription: { 
    model: 'whisper-1',
    prompt: 'Lifesaver, blood donor, O positive, O negative, A positive, B negative, AB positive, plasma, medicine, insulin, SOS, broadcast, hospital, urgency, HIGH, MEDIUM, LOW, Bengaluru'
},
    tool_choice: 'auto',
    tools: [
        {
            type: 'function',
            name: 'end_session',
            description: 'Call this if the user says bye or wants to end the session.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Reason for ending session.' },
                },
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
                    item:     { type: 'string', description: 'Blood type e.g. O+, B- or medicine name e.g. Insulin' },
                    category: { type: 'string', enum: ['BLOOD', 'MEDICINE'], description: 'Blood or medicine emergency' },
                    hospital: { type: 'string', description: 'Hospital or location name' },
                    urgency:  { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Urgency level' },
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
                    item:     { type: 'string', description: 'Blood type e.g. O+, B- or medicine name' },
                    category: { type: 'string', enum: ['BLOOD', 'MEDICINE'], description: 'Blood or medicine search' },
                },
                required: ['item', 'category'],
            },
        },
    ],
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