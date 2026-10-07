-- CreateEnum
CREATE TYPE "EstadoBorrador" AS ENUM ('PENDIENTE', 'APROBADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "borradores" (
    "id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "estado" "EstadoBorrador" NOT NULL DEFAULT 'PENDIENTE',
    "datos" JSONB NOT NULL,
    "creado_en" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "borradores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "borradores_chat_id_estado_idx" ON "borradores"("chat_id", "estado");
