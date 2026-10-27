`timescale 1ns/1ps
// sample_top against the SPI ADC model (spi_adc_slave.v) reading 3722 (12 V at the input): the average must reach
// 3722 after four conversions, the LED must light, and the UART must carry "0E8A\n". Fast settings: a conversion
// every 400 clocks and 8 clocks per UART bit.
module sample_top_tb;
    reg clk = 0;
    always #41.667 clk = ~clk;   // 12 MHz
    reg rst_n = 0;
    wire sck, cs_n, mosi, miso, tx, led;
    sample_top #(.SAMPLE_DIV(400), .CLKS_PER_BIT(8)) dut (.clk(clk), .rst_n(rst_n), .adc_sck(sck), .adc_cs_n(cs_n),
        .adc_mosi(mosi), .adc_miso(miso), .uart_tx(tx), .led(led));
    wire [15:0] command;
    spi_adc_slave adc (.sck(sck), .cs_n(cs_n), .mosi(mosi), .miso(miso), .sample(12'd3722), .command(command));

    // UART receiver: sample each bit in its middle (8 clocks per bit)
    reg [7:0] rx_bytes [0:63];
    integer nrx = 0;
    integer i;
    reg [7:0] b;
    initial begin
        forever begin
            @(negedge tx);
            repeat (4) @(posedge clk);
            if (tx == 1'b0) begin
                for (i = 0; i < 8; i = i + 1) begin
                    repeat (8) @(posedge clk);
                    b[i] = tx;
                end
                repeat (8) @(posedge clk);
                if (tx !== 1'b1) begin $display("FAIL: stop bit low"); $fatal(1); end
                rx_bytes[nrx] = b;
                nrx = nrx + 1;
            end
        end
    end

    integer k, last_nl;
    initial begin
        $dumpfile("sample_top_tb.vcd");
        $dumpvars(0, sample_top_tb);
        repeat (5) @(posedge clk);
        rst_n = 1;
        // five conversions at 400 clocks each, plus the reports
        repeat (2600) @(posedge clk);
        if (dut.avg !== 12'd3722) begin $display("FAIL: avg %0d, expected 3722", dut.avg); $fatal(1); end
        $display("TRACE_COVER avg_settled");
        if (led !== 1'b1) begin $display("FAIL: LED off at 12 V"); $fatal(1); end
        $display("TRACE_COVER led_on");
        // the last complete report line must be 0E8A
        last_nl = -1;
        for (k = 0; k < nrx; k = k + 1) if (rx_bytes[k] == 8'd10) last_nl = k;
        if (last_nl < 4) begin $display("FAIL: no complete UART report (%0d bytes)", nrx); $fatal(1); end
        if (rx_bytes[last_nl-4] != "0" || rx_bytes[last_nl-3] != "E" || rx_bytes[last_nl-2] != "8" || rx_bytes[last_nl-1] != "A") begin
            $display("FAIL: UART report %c%c%c%c", rx_bytes[last_nl-4], rx_bytes[last_nl-3], rx_bytes[last_nl-2], rx_bytes[last_nl-1]);
            $fatal(1);
        end
        $display("TRACE_COVER uart_report");
        $display("UART reports: %0d bytes, last 0E8A", nrx);
        $display("ALL TESTS PASSED");
        $finish;
    end
endmodule
