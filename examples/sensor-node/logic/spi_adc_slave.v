// The digital side of an SPI ADC reading ADC_IN, as the sensor node's MCU sees it: SPI mode 0, one 16-bit word per
// chip select, MSB first. MISO carries four zero bits and then the 12-bit conversion result latched when CS falls
// (bit 15 is on the line as CS goes low, each following bit after an SCK falling edge). MOSI is shifted in on SCK
// rising edges into `command` (the last word received), so the MCU's command path is checked too.
//
// It stands for an ADC such as the ones protocol.spec holds as the fixture "SPI-ADC-12 (fixture)": the interface is a
// generic one, not a particular part's. protocol.testbench drives it with the model's transactions
// (spi_adc_slave_tb.v, generated) and checks every MISO bit where the master samples it.
`timescale 1ns/1ps
module spi_adc_slave (
  input  wire        sck,
  input  wire        cs_n,
  input  wire        mosi,
  output wire        miso,
  input  wire [11:0] sample,
  output reg  [15:0] command
);
  reg [15:0] shift_out;
  reg [15:0] shift_in;
  reg [4:0]  count;

  // the result is latched as the conversion starts; MISO is high impedance while deselected
  always @(negedge cs_n) begin
    shift_out <= {4'b0000, sample};
    count <= 0;
  end

  always @(posedge sck) if (!cs_n) begin
    shift_in <= {shift_in[14:0], mosi};
    count <= count + 1;
    if (count == 15) command <= {shift_in[14:0], mosi};
  end

  always @(negedge sck) if (!cs_n) shift_out <= {shift_out[14:0], 1'b0};

  assign miso = cs_n ? 1'bz : shift_out[15];
endmodule
