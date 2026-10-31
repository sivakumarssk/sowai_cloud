-- RAM the host itself uses, written by the ServerMonitor. Null until measured.
ALTER TABLE "ProxmoxNode" ADD COLUMN "hostUsedRamMB" INTEGER;
