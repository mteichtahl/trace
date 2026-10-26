// A small FPGA design for trace's implementation tools: a free-running counter blinks one LED and a PWM breathes the
// other. The same source builds for an iCE40 UP5K (iCEBreaker), an ECP5 (ULX3S) and a Gowin GW1NR-9 (Tang Nano 9K);
// the constraint files beside it hold each board's pins and clock.
//
//   fpga.synth  family=ice40 files=[blinky.v] top=blinky
//   fpga.pnr    family=ice40 device=up5k package=sg48 synth_run=<run> constraints=icebreaker.pcf
//   fpga.bitstream family=ice40 run_id=<pnr run>
`default_nettype none
module blinky #(
    parameter WIDTH = 24      // the blink period is 2^WIDTH clocks: 1.4 s at 12 MHz
) (
    input  wire clk,
    input  wire rst_n,        // a button: low resets the counter
    output wire led_r,
    output wire led_g
);
    reg [WIDTH-1:0] count = 0;
    always @(posedge clk) begin
        if (!rst_n) count <= 0;
        else count <= count + 1'b1;
    end

    // the breathing LED: brightness rises and falls with the counter's top bits
    wire [7:0] level = count[WIDTH-1] ? ~count[WIDTH-2 -: 8] : count[WIDTH-2 -: 8];
    wire       pwm_out;
    pwm #(.BITS(8)) u_pwm (.clk(clk), .level(level), .out(pwm_out));

    assign led_r = count[WIDTH-1];
    assign led_g = pwm_out;
endmodule

// out is high for `level` of every 2^BITS clocks
module pwm #(
    parameter BITS = 8
) (
    input  wire            clk,
    input  wire [BITS-1:0] level,
    output reg             out = 1'b0
);
    reg [BITS-1:0] phase = 0;
    always @(posedge clk) begin
        phase <= phase + 1'b1;
        out <= phase < level;
    end
endmodule
`default_nettype wire
