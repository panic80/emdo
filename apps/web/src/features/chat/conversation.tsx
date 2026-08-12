import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { Icon } from '../../components/icon.js';
import { VoicePanel } from '../voice/voice-panel.js';
import { SpokenReplyControls } from '../voice/spoken-reply-controls.js';
import { speakSummary } from '../voice/voice-api.js';
import {
  createTurn,
  PersistedRunEventBuffer,
  readRunEvents,
  type AssistantSpecialist,
  type PersistedRunEvent,
} from './sse-client.js';
import { AskComposer } from './ask-composer.js';
import { useAuth } from '../auth/auth-context.js';

export interface ConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly pending?: boolean;
}

interface ConversationState {
  readonly messages: readonly ConversationMessage[];
  readonly status: 'idle' | 'starting' | 'streaming' | 'error';
  readonly error?: string;
  readonly submit: (
    message: string,
    specialist?: AssistantSpecialist,
  ) => Promise<{ readonly turnId: string; readonly text: string } | undefined>;
}

const ConversationContext = createContext<ConversationState | undefined>(
  undefined,
);

function eventEnvelope(event: PersistedRunEvent): {
  readonly type: string;
  readonly payload: unknown;
} {
  if (!event.data || typeof event.data !== 'object')
    return { type: event.type, payload: event.data };
  const envelope = event.data as Record<string, unknown>;
  return {
    type: typeof envelope.type === 'string' ? envelope.type : event.type,
    payload: envelope.data,
  };
}

function textFromPayload(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.delta === 'string') return record.delta;
  return undefined;
}

export function ConversationProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'What can I help you plan today?',
    },
  ]);
  const [status, setStatus] = useState<ConversationState['status']>('idle');
  const [error, setError] = useState<string>();
  const controllers = useRef(new Set<AbortController>());

  const submit = async (
    rawMessage: string,
    specialist: AssistantSpecialist = 'manager',
  ) => {
    const message = rawMessage.trim();
    if (!message) return;
    const csrfToken = auth.csrfToken ?? '';
    const userMessage: ConversationMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: 'user',
      text: message,
    };
    setMessages((current) => [...current, userMessage]);
    setError(undefined);

    if (!csrfToken) {
      setStatus('error');
      setError(
        'Your secure session needs to be refreshed before EMDO can send this request.',
      );
      return;
    }

    const controller = new AbortController();
    controllers.current.add(controller);
    setStatus('starting');
    try {
      const turn = await createTurn(
        {
          message,
          specialist,
          csrfToken,
          idempotencyKey: `turn-${crypto.randomUUID()}`,
        },
        { signal: controller.signal },
      );
      const assistantId = `assistant-${turn.runId}`;
      setMessages((current) => [
        ...current,
        { id: assistantId, role: 'assistant', text: '', pending: true },
      ]);
      setStatus('streaming');
      const buffer = new PersistedRunEventBuffer();
      let assistantText = '';
      for await (const event of readRunEvents(turn.runId, {
        signal: controller.signal,
      })) {
        if (!buffer.append(event)) continue;
        const { type, payload } = eventEnvelope(event);
        const text = textFromPayload(payload);
        if (type === 'assistant.delta' && text) {
          assistantText += text;
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId
                ? { ...item, text: `${item.text}${text}` }
                : item,
            ),
          );
        }
        if (type === 'assistant.message' && text) {
          assistantText = text;
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId
                ? { ...item, text, pending: false }
                : item,
            ),
          );
        }
        if (type === 'run.failed') {
          setError(
            'EMDO could not finish that request. Your conversation is still saved.',
          );
        }
      }
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId ? { ...item, pending: false } : item,
        ),
      );
      setStatus('idle');
      return { turnId: turn.runId, text: assistantText };
    } catch (caught) {
      if (controller.signal.aborted) return;
      setStatus('error');
      setError(
        caught instanceof Error
          ? caught.message
          : 'EMDO could not complete that request.',
      );
    } finally {
      controllers.current.delete(controller);
    }
  };

  const value = useMemo(
    () => ({ messages, status, error, submit }),
    [auth.csrfToken, messages, status, error],
  );
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation(): ConversationState {
  const context = useContext(ConversationContext);
  if (!context)
    throw new Error('useConversation must be used inside ConversationProvider');
  return context;
}

export function ConversationPanel({
  specialist = 'manager',
}: {
  readonly specialist?: AssistantSpecialist;
}) {
  const auth = useAuth();
  const conversation = useConversation();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [spokenReply, setSpokenReply] = useState<{
    readonly response: Response;
    readonly turnId: string;
    readonly captions: string;
  }>();
  const [speechError, setSpeechError] = useState<string>();

  return (
    <section className="conversation-panel" aria-label="EMDO conversation">
      <div className="conversation-messages" aria-live="polite">
        {conversation.messages.map((message) => (
          <article
            className={`message message--${message.role}`}
            key={message.id}
          >
            <span className="message__sender">
              {message.role === 'assistant' ? 'EMDO' : 'You'}
            </span>
            <p>{message.text || (message.pending ? 'Thinking…' : '')}</p>
          </article>
        ))}
      </div>
      {conversation.error ? (
        <p className="conversation-error" role="alert">
          <Icon name="info" size={20} /> {conversation.error}
        </p>
      ) : null}
      <AskComposer
        compact
        onSubmit={async (message) => {
          await conversation.submit(message, specialist);
        }}
        onVoiceRequest={() => setVoiceOpen(true)}
      />
      <VoicePanel
        csrfToken={auth.csrfToken ?? ''}
        onClose={() => setVoiceOpen(false)}
        onUseTranscript={(transcript) => {
          setSpeechError(undefined);
          setSpokenReply(undefined);
          void conversation
            .submit(transcript, specialist)
            .then(async (result) => {
              if (!result?.text) return;
              const csrfToken = auth.csrfToken;
              if (!csrfToken) return;
              try {
                const response = await speakSummary({
                  text: result.text,
                  csrfToken,
                  idempotencyKey: `speech-${crypto.randomUUID()}`,
                });
                setSpokenReply({
                  response,
                  turnId: result.turnId,
                  captions: result.text,
                });
              } catch {
                setSpeechError(
                  'EMDO could not create the spoken summary. The full text remains available.',
                );
              }
            });
        }}
        open={voiceOpen}
      />
      {spokenReply ? <SpokenReplyControls {...spokenReply} /> : null}
      {speechError ? (
        <p className="inline-error" role="alert">
          {speechError}
        </p>
      ) : null}
    </section>
  );
}
