-- AlterTable
ALTER TABLE "borradores" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "version_mostrada" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "borradores_chat_id_pendiente_key" ON "borradores"("chat_id") WHERE (estado = 'PENDIENTE');

