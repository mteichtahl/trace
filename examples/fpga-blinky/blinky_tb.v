// Testbench for blinky at WIDTH = 10 (a 1024-clock blink): the red LED must change state every 512 clocks.
`timescale 1ns/1ps
`default_nettype none
module blinky_tb;
    reg clk = 0, rst_n = 0;
    wire led_r, led_g;
    blinky #(.WIDTH(10)) dut (.clk(clk), .rst_n(rst_n), .led_r(led_r), .led_g(led_g));
    always #5 clk = ~clk;
    integer i, toggles = 0;
    reg last = 0;
    initial begin
        repeat (4) @(posedge clk);
        rst_n = 1;
        for (i = 0; i < 4096; i = i + 1) begin
            @(posedge clk);
            if (led_r !== last) toggles = toggles + 1;
            last = led_r;
        end
        // 4096 clocks with a 1024-clock period: the red LED changes every 512 clocks
        if (toggles < 7 || toggles > 9) $fatal(1, "led_r toggled %0d times, expected 7 to 9", toggles);
        $display("TRACE_COVER led_r_toggles %0d", toggles);
        $display("ALL TESTS PASSED");
        $finish;
    end
endmodule
`default_nettype wire
