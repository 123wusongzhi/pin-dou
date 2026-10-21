__device__ double delta_e_2000(const double* first, const double* second) {
    const double pi = 3.1415926535897932384626433832795;
    const double rad = pi / 180.0;
    const double L1 = first[0], a1 = first[1], b1 = first[2];
    const double L2 = second[0], a2 = second[1], b2 = second[2];
    const double C1 = hypot(a1, b1), C2 = hypot(a2, b2);
    const double C = (C1 + C2) / 2.0;
    const double C7 = pow(C, 7.0);
    const double G = 0.5 * (1.0 - sqrt(C7 / (C7 + 6103515625.0)));
    const double ap1 = (1.0 + G) * a1, ap2 = (1.0 + G) * a2;
    const double cp1 = hypot(ap1, b1), cp2 = hypot(ap2, b2);
    double hp1 = cp1 == 0.0 ? 0.0 : atan2(b1, ap1) / rad;
    double hp2 = cp2 == 0.0 ? 0.0 : atan2(b2, ap2) / rad;
    if (hp1 < 0.0) hp1 += 360.0;
    if (hp2 < 0.0) hp2 += 360.0;
    const double dL = L2 - L1, dC = cp2 - cp1;
    double dh = hp2 - hp1;
    // Opposite hues are exactly 180 degrees; atan2 can cross that boundary by
    // a few float64 ulps. Preserve the standard's <= 180 branch in that case.
    if (fabs(fabs(dh) - 180.0) < 1e-12) dh = copysign(180.0, dh);
    if (cp1 * cp2 == 0.0) dh = 0.0;
    else if (dh > 180.0) dh -= 360.0;
    else if (dh < -180.0) dh += 360.0;
    const double dH = 2.0 * sqrt(cp1 * cp2) * sin(dh * rad / 2.0);
    const double Lbar = (L1 + L2) / 2.0;
    const double Cbar = (cp1 + cp2) / 2.0;
    double Hbar;
    if (cp1 * cp2 == 0.0) Hbar = hp1 + hp2;
    else if (fabs(hp1 - hp2) <= 180.0 + 1e-12) Hbar = (hp1 + hp2) / 2.0;
    else if (hp1 + hp2 < 360.0) Hbar = (hp1 + hp2 + 360.0) / 2.0;
    else Hbar = (hp1 + hp2 - 360.0) / 2.0;
    const double T = 1.0 - 0.17 * cos((Hbar - 30.0) * rad)
        + 0.24 * cos(2.0 * Hbar * rad)
        + 0.32 * cos((3.0 * Hbar + 6.0) * rad)
        - 0.20 * cos((4.0 * Hbar - 63.0) * rad);
    const double theta = 30.0 * exp(-pow((Hbar - 275.0) / 25.0, 2.0));
    const double Cbar7 = pow(Cbar, 7.0);
    const double RC = 2.0 * sqrt(Cbar7 / (Cbar7 + 6103515625.0));
    const double lightness = (Lbar - 50.0) * (Lbar - 50.0);
    const double SL = 1.0 + 0.015 * lightness / sqrt(20.0 + lightness);
    const double SC = 1.0 + 0.045 * Cbar;
    const double SH = 1.0 + 0.015 * Cbar * T;
    const double RT = -sin(2.0 * theta * rad) * RC;
    const double dl = dL / SL, dc = dC / SC, dhh = dH / SH;
    return sqrt(fmax(0.0, dl * dl + dc * dc + dhh * dhh + RT * dc * dhh));
}

// Each palette row is contiguous so candidate scoring reads coalesced memory.
extern "C" __global__ void distance_matrix(
    const double* samples, const double* palette, double* distances,
    const int sample_count, const int color_count
) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < sample_count * color_count) {
        const int color = index / sample_count;
        const int sample = index % sample_count;
        distances[index] = delta_e_2000(samples + sample * 3, palette + color * 3);
    }
}

extern "C" __global__ void paired_distances(
    const double* left, const double* right, double* distances, const int count
) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < count)
        distances[index] = delta_e_2000(left + index * 3, right + index * 3);
}

extern "C" __global__ void marginal_gains(
    const double* distances, const double* weights, const double* best,
    double* scores, const int sample_count
) {
    __shared__ double subtotal[256];
    const int color = blockIdx.x;
    double sum = 0.0;
    for (int sample = threadIdx.x; sample < sample_count; sample += blockDim.x)
        sum += weights[sample] * fmax(
            0.0, best[sample] - distances[color * sample_count + sample]
        );
    subtotal[threadIdx.x] = sum;
    __syncthreads();
    for (int size = blockDim.x / 2; size > 0; size /= 2) {
        if (threadIdx.x < size) subtotal[threadIdx.x] += subtotal[threadIdx.x + size];
        __syncthreads();
    }
    if (threadIdx.x == 0) scores[color] = subtotal[0];
}

extern "C" __global__ void swap_gains(
    const double* distances, const double* weights, const double* best,
    const double* second, const long long* owners, const int* candidates,
    double* scores, const int sample_count, const int candidate_count
) {
    __shared__ double subtotal[256];
    const int removed_slot = blockIdx.x / candidate_count;
    const int added_color = candidates[blockIdx.x % candidate_count];
    double sum = 0.0;
    for (int sample = threadIdx.x; sample < sample_count; sample += blockDim.x) {
        const double without = owners[sample] == removed_slot ? second[sample] : best[sample];
        const double replaced = fmin(without, distances[added_color * sample_count + sample]);
        sum += weights[sample] * (best[sample] - replaced);
    }
    subtotal[threadIdx.x] = sum;
    __syncthreads();
    for (int size = blockDim.x / 2; size > 0; size /= 2) {
        if (threadIdx.x < size) subtotal[threadIdx.x] += subtotal[threadIdx.x + size];
        __syncthreads();
    }
    if (threadIdx.x == 0) scores[blockIdx.x] = subtotal[0];
}
