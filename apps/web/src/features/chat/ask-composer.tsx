import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Icon } from '../../components/icon.js';

const AskFormSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Tell EMDO what you need help with.')
    .max(12_000),
});

type AskFormValues = z.input<typeof AskFormSchema>;

export function AskComposer({
  onSubmit,
  onVoiceRequest,
  compact = false,
  initialValue = '',
}: {
  readonly onSubmit: (message: string) => Promise<void> | void;
  readonly onVoiceRequest?: () => void;
  readonly compact?: boolean;
  readonly initialValue?: string;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AskFormValues>({
    resolver: zodResolver(AskFormSchema),
    defaultValues: { message: initialValue },
  });

  return (
    <form
      className={`ask-composer ${compact ? 'ask-composer--compact' : ''}`.trim()}
      onSubmit={handleSubmit(async ({ message }) => {
        await onSubmit(message.trim());
        reset({ message: '' });
      })}
      noValidate
    >
      <div className="ask-composer__control">
        <label className="sr-only" htmlFor="ask-emdo-message">
          Ask EMDO
        </label>
        <textarea
          {...register('message')}
          aria-describedby={errors.message ? 'ask-emdo-error' : undefined}
          aria-invalid={errors.message ? 'true' : undefined}
          id="ask-emdo-message"
          maxLength={12_000}
          placeholder="What can I help with?"
          rows={compact ? 1 : 2}
        />
        <button
          aria-label="Start push-to-talk"
          className="voice-trigger"
          onClick={onVoiceRequest}
          type="button"
        >
          <Icon name="microphone" size={23} />
        </button>
        <button
          className="ask-composer__submit"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Sending…' : 'Ask EMDO'}
        </button>
      </div>
      {errors.message ? (
        <p className="field-error" id="ask-emdo-error" role="alert">
          {errors.message.message}
        </p>
      ) : null}
    </form>
  );
}
