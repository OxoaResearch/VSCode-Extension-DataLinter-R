open("delim_file2.txt", "a") do io
        writedlm(io, reshape(["x_$i" for i in 1:125],(1,125)), ',')
        writedlm(io, rand(1_000_00,125), ',')
              end