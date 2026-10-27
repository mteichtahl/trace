`timescale 1ns/1ps
// The trace-sample's logic on an iCE40 UP5K (fpga/sample_top.pcf): read an SPI ADC on ADC_IN, average four samples
// (moving_average.v), report each average on a UART as four hex digits and a newline ("0E8A\n"), and light the LED
// while the input is above a threshold. The same job the MCU firmware does, as an FPGA alternative.
//
//   clk 12 MHz      the UP5K board oscillator
//   SPI mode 0      SCK = clk / 12 = 1 MHz, one 16-bit word per conversion, MISO = 0000 + 12-bit code (spi_adc_slave.v)
//   sample rate     one conversion every SAMPLE_DIV clocks (12000: 1 kHz)
//   UART            115200 8N1 (CLKS_PER_BIT 104 at 12 MHz: 115385 baud, +0.16 %)
//   LED             on while avg >= LED_THRESHOLD (3103 = 10 V at the input)
`default_nettype none
module sample_top #(
    parameter SAMPLE_DIV = 12000,
    parameter CLKS_PER_BIT = 104,
    parameter LED_THRESHOLD = 3103
) (
    input  wire clk,
    input  wire rst_n,
    output reg  adc_sck,
    output reg  adc_cs_n,
    output wire adc_mosi,
    input  wire adc_miso,
    output wire uart_tx,
    output wire led
);
    // ---- reset: two flops on the async button
    reg [1:0] rs = 2'b00;
    always @(posedge clk) rs <= {rs[0], rst_n};
    wire rst = ~rs[1];

    // ---- conversion timer
    reg [15:0] timer;
    wire start = (timer == 0);
    always @(posedge clk) timer <= (rst || timer == SAMPLE_DIV - 1) ? 16'd0 : timer + 16'd1;

    // ---- SPI master, mode 0: SCK idles low; MISO sampled on the rising edge; 16 bits
    reg [3:0]  div;        // 12 clocks per SCK period: 6 low, 6 high
    reg [4:0]  bits;
    reg [15:0] shift;
    reg        busy;
    reg        word_valid;
    reg [11:0] word;
    assign adc_mosi = 1'b0;          // the command word is all zeros: convert channel 0
    always @(posedge clk) begin
        word_valid <= 1'b0;
        if (rst) begin
            adc_sck <= 1'b0; adc_cs_n <= 1'b1; busy <= 1'b0; div <= 0; bits <= 0; shift <= 0; word <= 0;
        end else if (!busy) begin
            if (start) begin
                busy <= 1'b1; adc_cs_n <= 1'b0; div <= 0; bits <= 0;
            end
        end else begin
            div <= (div == 11) ? 4'd0 : div + 4'd1;
            if (div == 5 && bits < 16) begin
                adc_sck <= 1'b1;
                shift <= {shift[14:0], adc_miso};
                bits <= bits + 5'd1;
            end else if (div == 11) begin
                adc_sck <= 1'b0;
                if (bits == 16) begin
                    busy <= 1'b0; adc_cs_n <= 1'b1;
                    word <= shift[11:0]; word_valid <= 1'b1;
                end
            end
        end
    end

    // ---- the average
    wire [11:0] avg;
    wire        avg_valid;
    moving_average #(.WIDTH(12)) u_avg (.clk(clk), .rst(rst), .valid(word_valid), .sample(word), .avg(avg), .avg_valid(avg_valid));
    assign led = (avg >= LED_THRESHOLD);

    // ---- UART report: four hex digits and a newline per average
    reg [2:0]  ch;          // 0..4 while sending, 7 idle
    reg [15:0] report;
    reg        tx_start;
    wire       tx_busy;
    reg [7:0]  tx_byte;
    function [7:0] hex(input [3:0] n);
        hex = (n < 10) ? 8'd48 + {4'd0, n} : 8'd55 + {4'd0, n};
    endfunction
    always @(posedge clk) begin
        tx_start <= 1'b0;
        if (rst) begin
            ch <= 3'd7; report <= 0; tx_byte <= 0;
        end else if (avg_valid && ch == 3'd7) begin
            report <= {4'd0, avg}; ch <= 3'd0;
        end else if (ch != 3'd7 && !tx_busy && !tx_start) begin
            case (ch)
                3'd0: tx_byte <= hex(report[15:12]);
                3'd1: tx_byte <= hex(report[11:8]);
                3'd2: tx_byte <= hex(report[7:4]);
                3'd3: tx_byte <= hex(report[3:0]);
                default: tx_byte <= 8'd10;
            endcase
            tx_start <= 1'b1;
            ch <= (ch == 3'd4) ? 3'd7 : ch + 3'd1;
        end
    end
    uart_tx #(.CLKS_PER_BIT(CLKS_PER_BIT)) u_tx (.clk(clk), .rst(rst), .start(tx_start), .data(tx_byte), .tx(uart_tx), .busy(tx_busy));
endmodule

// 8N1 transmitter: start bit, eight data bits LSB first, one stop bit.
module uart_tx #(
    parameter CLKS_PER_BIT = 104
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       start,
    input  wire [7:0] data,
    output reg        tx,
    output wire       busy
);
    reg [9:0]  frame;
    reg [3:0]  n;
    reg [15:0] cnt;
    assign busy = (n != 0) || start;
    always @(posedge clk) begin
        if (rst) begin
            tx <= 1'b1; n <= 0; cnt <= 0; frame <= 10'h3ff;
        end else if (n == 0) begin
            if (start) begin
                frame <= {1'b1, data, 1'b0}; n <= 4'd10; cnt <= 0;
            end
        end else if (cnt == CLKS_PER_BIT - 1) begin
            cnt <= 0;
            n <= n - 4'd1;
            frame <= {1'b1, frame[9:1]};
        end else begin
            cnt <= cnt + 16'd1;
        end
        if (n != 0) tx <= frame[0];
        else if (!rst) tx <= 1'b1;
    end
endmodule
`default_nettype wire
