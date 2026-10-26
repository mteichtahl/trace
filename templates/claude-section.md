<!-- trace -->
## trace

This repository is run by [trace](https://github.com/mteichtahl/trace). Its rules for agents are in
`.trace/rules.md`; read them first, they are the authority. Settings live in `.trace/project.db` (change them with
`trace config set <key> <value>`, never by editing the file), and every tool run is recorded there.

The `trace` MCP server (`claude mcp add trace -- trace mcp`) gives you the electronics tools: KiCad reading and
ERC/DRC, BOM and part lookup, the datasheet library shared by every project, calculators, SPICE and Verilog
simulation, the firmware loop, and hardware in the loop on a machine wired to the bench (`TRACE_HARDWARE=1`).
