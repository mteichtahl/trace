/* The MCU board's memory (a small Cortex-M0+ with 64 KiB flash and 16 KiB RAM), for firmware.size's percentages.
 * The image built here is a host executable, so its sizes are the host's, not the MCU's: the figures show the tool
 * working, and become the MCU's when the Makefile builds with arm-none-eabi-gcc. */
MEMORY
{
  FLASH : ORIGIN = 0x08000000, LENGTH = 64K
  RAM   : ORIGIN = 0x20000000, LENGTH = 16K
}
