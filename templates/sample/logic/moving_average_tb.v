// Self-checking testbench for moving_average: feeds samples (steps, the full-scale code, a ramp and pseudo-random
// values, with gaps between samples), computes the expected average itself, and stops with $fatal on any mismatch.
// Prints "ALL TESTS PASSED" at the end.
`timescale 1ns/1ps
`default_nettype none
module moving_average_tb;
    reg         clk = 0, rst = 1, valid = 0;
    reg  [11:0] sample = 0;
    wire [11:0] avg;
    wire        avg_valid;

    moving_average #(.WIDTH(12)) dut (.clk(clk), .rst(rst), .valid(valid), .sample(sample), .avg(avg), .avg_valid(avg_valid));

    always #5 clk = ~clk;   // 100 MHz

    integer hist [0:3];
    integer checked = 0, i, gap;
    reg [31:0] lfsr = 32'hACE1_2345;

    task push(input [11:0] s);
        integer want;
        begin
            hist[3] = hist[2]; hist[2] = hist[1]; hist[1] = hist[0]; hist[0] = s;
            want = (hist[0] + hist[1] + hist[2] + hist[3]) / 4;
            @(negedge clk); sample = s; valid = 1;
            @(negedge clk); valid = 0;
            if (!avg_valid) $fatal(1, "avg_valid not set after sample %0d", s);
            if (avg !== want[11:0]) $fatal(1, "MISMATCH after sample %0d: avg %0d, expected %0d", s, avg, want);
            checked = checked + 1;
            @(negedge clk);
            if (avg_valid) $fatal(1, "avg_valid held for more than one clock");
        end
    endtask

    initial begin
        $dumpfile("moving_average_tb.vcd");
        $dumpvars(0, moving_average_tb);
        for (i = 0; i < 4; i = i + 1) hist[i] = 0;
        repeat (3) @(negedge clk);
        rst = 0;
        // a step from 0 to 3723 (12 V in): the average climbs in quarters
        repeat (5) push(12'd3723);
        // full scale and back to zero
        repeat (4) push(12'd4095);
        repeat (4) push(12'd0);
        // a ramp
        for (i = 0; i < 40; i = i + 1) push(i * 100);
        // pseudo-random samples with random gaps between them
        for (i = 0; i < 200; i = i + 1) begin
            lfsr = {lfsr[30:0], lfsr[31] ^ lfsr[21] ^ lfsr[1] ^ lfsr[0]};
            gap = lfsr[19:17];
            repeat (gap) @(negedge clk);
            push(lfsr[11:0]);
        end
        // reset clears the history
        @(negedge clk); rst = 1; @(negedge clk); rst = 0;
        for (i = 0; i < 4; i = i + 1) hist[i] = 0;
        push(12'd400);
        if (avg !== 12'd100) $fatal(1, "after reset expected 100, got %0d", avg);
        $display("checked %0d samples", checked);
        $display("ALL TESTS PASSED");
        $finish;
    end
endmodule
`default_nettype wire
