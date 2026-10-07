import { z } from 'zod';

/**
 * Variables de entorno que la aplicación necesita para arrancar.
 * Si falta alguna o tiene un formato inválido, la app se detiene al iniciar
 * con un mensaje claro, en lugar de fallar más tarde a mitad de una operación.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Formato de BotFather: <id numérico>:<secreto>
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(
      /^\d+:[\w-]{30,}$/,
      'Token de Telegram inválido (pídelo a @BotFather)',
    ),
  OLLAMA_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODELO_TEXTO: z.string().min(1).default('qwen2.5:3b'),
  // IDs de chat que pueden usar el bot, separados por comas. Vacío = nadie (seguro por defecto).
  TELEGRAM_CHATS_PERMITIDOS: z
    .string()
    .default('')
    .transform((lista) =>
      lista
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .regex(/^-?\d+$/, 'Cada ID de chat debe ser numérico')
          .transform(Number),
      ),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Variables de entorno inválidas:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
