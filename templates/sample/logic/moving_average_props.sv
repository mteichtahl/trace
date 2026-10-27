// Formal properties for moving_average: a wrapper that drives the filter with any inputs a solver picks, keeps its own
// record of the last four samples, and asserts what the filter must do. Reset is assumed in the first cycle only.
//
//   avg_valid is high exactly in the clock after an accepted sample (valid while not in reset)
//   whenever avg_valid is high, avg is the mean of the last four samples (missing ones counting as zero)
//   cover: the average reaches full scale
//
// W is the sample width. The arithmetic is the same at any width, and a narrow one keeps the solver quick (W = 4 is
// what moving_average.sby checks); the testbenches cover the 12-bit build.
`default_nettype none
module moving_average_props #(
    parameter W = 4
) (
    input wire         clk,
    input wire         rst,
    input wire         valid,
    input wire [W-1:0] sample
);
    wire [W-1:0] avg;
    wire         avg_valid;

    moving_average #(.WIDTH(W)) dut (.clk(clk), .rst(rst), .valid(valid), .sample(sample), .avg(avg), .avg_valid(avg_valid));

    reg         init = 1'b1;
    reg [W-1:0] h0 = 0, h1 = 0, h2 = 0, h3 = 0;
    reg         accepted = 1'b0;

    always @(posedge clk) begin
        init <= 1'b0;
        accepted <= !rst && valid;
        if (rst) begin
            h0 <= 0; h1 <= 0; h2 <= 0; h3 <= 0;
        end else if (valid) begin
            h3 <= h2; h2 <= h1; h1 <= h0; h0 <= sample;
        end
    end

    always @(*) if (init) assume(rst);

    wire [W+1:0] want = h0 + h1 + h2 + h3;

    always @(posedge clk) if (!init) begin
        valid_follows_sample: assert(avg_valid == accepted);
        if (avg_valid) mean_of_last_four: assert(avg == want[W+1:2]);
        reaches_full_scale: cover(avg_valid && avg == {W{1'b1}});
    end
endmodule
`default_nettype wire
