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
