-- CreateEnum
CREATE TYPE "EstadoEmision" AS ENUM ('PENDIENTE', 'CREANDO_BORRADOR', 'BORRADOR_CREADO', 'TIMBRANDO', 'EMITIDA', 'RECHAZADA', 'NO_CREADA', 'DESCONOCIDO', 'CANCELADA');

-- CreateEnum
CREATE TYPE "ModoEmision" AS ENUM ('SOLO_BORRADOR', 'TIMBRAR');

-- CreateEnum
CREATE TYPE "EstadoDian" AS ENUM ('PENDIENTE', 'ACEPTADA', 'RECHAZADA');

-- CreateTable
CREATE TABLE "emisiones" (
    "id" UUID NOT NULL,
    "borrador_id" UUID NOT NULL,
    "proveedor" "ProveedorFacturacion" NOT NULL,
    "cuenta_proveedor" TEXT NOT NULL,
    "modo" "ModoEmision" NOT NULL,
    "estado" "EstadoEmision" NOT NULL DEFAULT 'PENDIENTE',
    "fecha_factura" DATE NOT NULL,
    "id_externo" TEXT,
    "numero" TEXT,
    "cufe" TEXT,
    "estado_dian" "EstadoDian",
    "codigo_error" TEXT,
    "creada_en" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ NOT NULL,
    "emitida_en" TIMESTAMPTZ,

    CONSTRAINT "emisiones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "emisiones_borrador_id_key" ON "emisiones"("borrador_id");

-- CreateIndex
CREATE INDEX "emisiones_estado_idx" ON "emisiones"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "emisiones_proveedor_cuenta_id_externo_key" ON "emisiones"("proveedor", "cuenta_proveedor", "id_externo");

-- AddForeignKey
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_borrador_id_fkey" FOREIGN KEY ("borrador_id") REFERENCES "borradores"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Escrito a mano: Prisma no modela restricciones CHECK (docs/planes/fase-5-alegra.md §4).
-- Desde que existe el borrador en el proveedor, su id tiene que estar guardado.
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_id_externo_segun_estado_check"
  CHECK ("estado" NOT IN ('BORRADOR_CREADO', 'TIMBRANDO', 'EMITIDA', 'RECHAZADA') OR "id_externo" IS NOT NULL);

-- Una emisión que nació con ALEGRA_EMITIR apagada nunca llega a timbrarse.
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_solo_borrador_no_timbra_check"
  CHECK ("modo" <> 'SOLO_BORRADOR' OR "estado" NOT IN ('TIMBRANDO', 'EMITIDA', 'RECHAZADA'));
