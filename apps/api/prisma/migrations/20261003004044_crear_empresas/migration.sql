-- CreateEnum
CREATE TYPE "ProveedorFacturacion" AS ENUM ('ALEGRA', 'SIIGO');

-- CreateEnum
CREATE TYPE "ModoLineas" AS ENUM ('SIMPLE', 'DETALLADO');

-- CreateTable
CREATE TABLE "empresas" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "proveedor" "ProveedorFacturacion" NOT NULL,
    "modo_lineas" "ModoLineas" NOT NULL DEFAULT 'SIMPLE',
    "creada_en" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empresas_nit_key" ON "empresas"("nit");
