/**
 * EpitopX AI — DNA → Protein Translation Engine
 *
 * Scientific references:
 *  [1] NCBI Genetic Codes — Standard Genetic Code (Table 1)
 *      https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi
 *  [2] Gasteiger E. et al. (2005). Protein Identification and Analysis Tools
 *      on the ExPASy Server. Proteomics Protocols Handbook. DOI:10.1385/1592598900
 *  [3] Bjellqvist B. et al. (1993). The focusing positions of polypeptides in
 *      immobilized pH gradients. Electrophoresis 14:1023-1031.
 *  [4] Kyte J. & Doolittle R.F. (1982). A simple method for displaying the
 *      hydropathic character of a protein. J Mol Biol 157:105-132.
 *  [5] Pace C.N. et al. (1995). How to measure and predict the molar absorption
 *      coefficient of a protein at 280 nm. Protein Science 4:2411-2423.
 *  [6] Guruprasad K. et al. (1990). Correlation between stability of a protein
 *      and its dipeptide composition. Protein Engineering 4:155-161.
 *  [7] Ikai A. (1980). Thermostability and aliphatic index of globular proteins.
 *      J Biochem 88:1895-1898.
 *  [8] Lobry J.R. (1994). Asymmetric substitution patterns in the two DNA strands
 *      of bacteria. Mol Biol Evol 13(5):660-665.
 */

var DNAUtils = typeof DNAUtils !== 'undefined' ? DNAUtils : (() => {

  // ─────────────────────────────────────────────────────────────────────────
  // NCBI Standard Genetic Code (Table 1) — [1]
  // ─────────────────────────────────────────────────────────────────────────
  const CODON_TABLE = {
    'TTT':'F','TTC':'F','TTA':'L','TTG':'L',
    'CTT':'L','CTC':'L','CTA':'L','CTG':'L',
    'ATT':'I','ATC':'I','ATA':'I','ATG':'M',
    'GTT':'V','GTC':'V','GTA':'V','GTG':'V',
    'TCT':'S','TCC':'S','TCA':'S','TCG':'S',
    'CCT':'P','CCC':'P','CCA':'P','CCG':'P',
    'ACT':'T','ACC':'T','ACA':'T','ACG':'T',
    'GCT':'A','GCC':'A','GCA':'A','GCG':'A',
    'TAT':'Y','TAC':'Y','TAA':'*','TAG':'*',
    'CAT':'H','CAC':'H','CAA':'Q','CAG':'Q',
    'AAT':'N','AAC':'N','AAA':'K','AAG':'K',
    'GAT':'D','GAC':'D','GAA':'E','GAG':'E',
    'TGT':'C','TGC':'C','TGA':'*','TGG':'W',
    'CGT':'R','CGC':'R','CGA':'R','CGG':'R',
    'AGT':'S','AGC':'S','AGA':'R','AGG':'R',
    'GGT':'G','GGC':'G','GGA':'G','GGG':'G'
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Average residue molecular weights (Da) — [2] ExPASy ProtParam formula
  // Values = amino acid MW − 18.02 Da (water released per peptide bond)
  // ─────────────────────────────────────────────────────────────────────────
  const RESIDUE_WEIGHTS = {
    'A':71.0788,'R':156.1875,'N':114.1038,'D':115.0886,'C':103.1388,
    'E':129.1155,'Q':128.1307,'G':57.0519,'H':137.1411,'I':113.1594,
    'L':113.1594,'K':128.1741,'M':131.1926,'F':147.1766,'P':97.1167,
    'S':87.0782,'T':101.1051,'W':186.2132,'Y':163.1760,'V':99.1326
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Kyte-Doolittle hydrophobicity scale — [4]
  // ─────────────────────────────────────────────────────────────────────────
  const HYDROPHOBICITY = {
    'A':1.8,'R':-4.5,'N':-3.5,'D':-3.5,'C':2.5,'E':-3.5,'Q':-3.5,
    'G':-0.4,'H':-3.2,'I':4.5,'L':3.8,'K':-3.9,'M':1.9,'F':2.8,
    'P':-1.6,'S':-0.8,'T':-0.7,'W':-0.9,'Y':-1.3,'V':4.2
  };

  // ─────────────────────────────────────────────────────────────────────────
  // pK values for isoelectric point — Lide 1994 (Bio-B fix)
  // Source: Lide D.R. (ed.) (1994). CRC Handbook of Chemistry and Physics.
  //         These solution-phase pKa values match the ExPASy ProtParam scale
  //         and supersede the original Bjellqvist 1993 IEF-gel values.
  // ─────────────────────────────────────────────────────────────────────────
  const PKA = {
    Nterm: 9.60, Cterm: 2.34,
    D: 3.86, E: 4.25, H: 6.04, C: 8.33, Y: 10.46, K: 10.54, R: 12.48
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Dipeptide Instability Weight Values (DIWV) — complete 400-entry matrix
  // Guruprasad K. et al. (1990). Protein Engineering 4(2):155-161. Table 2.
  // Reference implementation: ExPASy ProtParam / BioPython ProtParamData.
  // Bio-C fix: replaces the previous partial (~30 entry) subset.
  // Values = 1.0 are neutral; >1.0 destabilise; <1.0 stabilise.
  // ─────────────────────────────────────────────────────────────────────────
  const INSTABILITY_MATRIX = {
    // ── A ───────────────────────────────────────────────────────────────────
    'AA':1.0, 'AC':44.94,'AD':-7.49,'AE':1.0,  'AF':1.0,  'AG':1.0,  'AH':-7.49,
    'AI':1.0, 'AK':1.0,  'AL':1.0,  'AM':1.0,  'AN':1.0,  'AP':20.26,'AQ':1.0,
    'AR':1.0, 'AS':1.0,  'AT':1.0,  'AV':1.0,  'AW':1.0,  'AY':1.0,
    // ── C ───────────────────────────────────────────────────────────────────
    'CA':1.0, 'CC':1.0,  'CD':20.26,'CE':1.0,  'CF':1.0,  'CG':1.0,  'CH':33.60,
    'CI':1.0, 'CK':1.0,  'CL':20.26,'CM':33.60,'CN':1.0,  'CP':20.26,'CQ':-6.54,
    'CR':1.0, 'CS':1.0,  'CT':33.60,'CV':-6.54,'CW':24.68,'CY':1.0,
    // ── D ───────────────────────────────────────────────────────────────────
    'DA':1.0, 'DC':1.0,  'DD':1.0,  'DE':1.0,  'DF':-6.54,'DG':1.0,  'DH':1.0,
    'DI':1.0, 'DK':-7.49,'DL':1.0,  'DM':1.0,  'DN':1.0,  'DP':1.0,  'DQ':1.0,
    'DR':-6.54,'DS':20.26,'DT':-14.03,'DV':1.0,'DW':1.0,  'DY':1.0,
    // ── E ───────────────────────────────────────────────────────────────────
    'EA':1.0, 'EC':44.94,'ED':20.26,'EE':33.60,'EF':1.0,  'EG':1.0,  'EH':-6.54,
    'EI':20.26,'EK':1.0, 'EL':1.0,  'EM':1.0,  'EN':1.0,  'EP':20.26,'EQ':20.26,
    'ER':1.0, 'ES':20.26,'ET':1.0,  'EV':1.0,  'EW':-14.03,'EY':1.0,
    // ── F ───────────────────────────────────────────────────────────────────
    'FA':1.0, 'FC':1.0,  'FD':13.34,'FE':1.0,  'FF':1.0,  'FG':1.0,  'FH':1.0,
    'FI':1.0, 'FK':-14.03,'FL':1.0, 'FM':1.0,  'FN':1.0,  'FP':20.26,'FQ':1.0,
    'FR':1.0, 'FS':1.0,  'FT':1.0,  'FV':1.0,  'FW':1.0,  'FY':33.60,
    // ── G ───────────────────────────────────────────────────────────────────
    'GA':-7.49,'GC':1.0, 'GD':1.0,  'GE':1.0,  'GF':1.0,  'GG':13.34,'GH':1.0,
    'GI':-7.49,'GK':1.0, 'GL':1.0,  'GM':1.0,  'GN':-7.49,'GP':1.0,  'GQ':1.0,
    'GR':1.0, 'GS':1.0,  'GT':-7.49,'GV':1.0,  'GW':13.34,'GY':-7.49,
    // ── H ───────────────────────────────────────────────────────────────────
    'HA':1.0, 'HC':1.0,  'HD':1.0,  'HE':1.0,  'HF':-9.37,'HG':-9.37,'HH':1.0,
    'HI':44.94,'HK':24.68,'HL':1.0, 'HM':1.0,  'HN':24.68,'HP':-1.88,'HQ':1.0,
    'HR':1.0, 'HS':1.0,  'HT':-6.54,'HV':1.0,  'HW':-1.88,'HY':44.94,
    // ── I ───────────────────────────────────────────────────────────────────
    'IA':1.0, 'IC':1.0,  'ID':1.0,  'IE':44.94,'IF':1.0,  'IG':1.0,  'IH':13.34,
    'II':1.0, 'IK':-7.49,'IL':20.26,'IM':1.0,  'IN':1.0,  'IP':-1.88,'IQ':1.0,
    'IR':1.0, 'IS':1.0,  'IT':1.0,  'IV':-7.49,'IW':1.0,  'IY':1.0,
    // ── K ───────────────────────────────────────────────────────────────────
    'KA':1.0, 'KC':1.0,  'KD':1.0,  'KE':1.0,  'KF':1.0,  'KG':-7.49,'KH':1.0,
    'KI':-7.49,'KK':1.0, 'KL':-7.49,'KM':33.60,'KN':1.0,  'KP':-6.54,'KQ':24.68,
    'KR':33.60,'KS':1.0, 'KT':1.0,  'KV':-7.49,'KW':1.0,  'KY':1.0,
    // ── L ───────────────────────────────────────────────────────────────────
    'LA':1.0, 'LC':1.0,  'LD':1.0,  'LE':1.0,  'LF':1.0,  'LG':1.0,  'LH':1.0,
    'LI':1.0, 'LK':-7.49,'LL':1.0,  'LM':1.0,  'LN':1.0,  'LP':20.26,'LQ':33.60,
    'LR':20.26,'LS':1.0, 'LT':1.0,  'LV':1.0,  'LW':24.68,'LY':1.0,
    // ── M ───────────────────────────────────────────────────────────────────
    'MA':13.34,'MC':1.0, 'MD':1.0,  'ME':1.0,  'MF':1.0,  'MG':1.0,  'MH':58.28,
    'MI':1.0, 'MK':1.0,  'ML':1.0,  'MM':-1.88,'MN':1.0,  'MP':44.94,'MQ':-6.54,
    'MR':-6.54,'MS':44.94,'MT':-1.88,'MV':1.0, 'MW':1.0,  'MY':24.68,
    // ── N ───────────────────────────────────────────────────────────────────
    'NA':1.0, 'NC':-1.88,'ND':1.0,  'NE':1.0,  'NF':-14.03,'NG':-14.03,'NH':1.0,
    'NI':44.94,'NK':24.68,'NL':1.0, 'NM':1.0,  'NN':1.0,  'NP':-1.88,'NQ':-6.54,
    'NR':1.0, 'NS':1.0,  'NT':-7.49,'NV':1.0,  'NW':-9.37,'NY':1.0,
    // ── P ───────────────────────────────────────────────────────────────────
    'PA':20.26,'PC':-6.54,'PD':-6.54,'PE':18.38,'PF':20.26,'PG':1.0, 'PH':1.0,
    'PI':1.0, 'PK':1.0,  'PL':1.0,  'PM':-6.54,'PN':1.0,  'PP':20.26,'PQ':20.26,
    'PR':-6.54,'PS':20.26,'PT':1.0, 'PV':20.26,'PW':-1.88,'PY':1.0,
    // ── Q ───────────────────────────────────────────────────────────────────
    'QA':1.0, 'QC':-6.54,'QD':20.26,'QE':20.26,'QF':-6.54,'QG':1.0,  'QH':1.0,
    'QI':1.0, 'QK':1.0,  'QL':1.0,  'QM':1.0,  'QN':1.0,  'QP':20.26,'QQ':20.26,
    'QR':1.0, 'QS':44.94,'QT':1.0,  'QV':-6.54,'QW':1.0,  'QY':-6.54,
    // ── R ───────────────────────────────────────────────────────────────────
    'RA':1.0, 'RC':1.0,  'RD':1.0,  'RE':1.0,  'RF':1.0,  'RG':-7.49,'RH':20.26,
    'RI':1.0, 'RK':1.0,  'RL':1.0,  'RM':1.0,  'RN':13.34,'RP':20.26,'RQ':20.26,
    'RR':1.0, 'RS':44.94,'RT':1.0,  'RV':1.0,  'RW':58.28,'RY':-6.54,
    // ── S ───────────────────────────────────────────────────────────────────
    'SA':1.0, 'SC':33.60,'SD':1.0,  'SE':20.26,'SF':1.0,  'SG':1.0,  'SH':1.0,
    'SI':1.0, 'SK':1.0,  'SL':1.0,  'SM':1.0,  'SN':1.0,  'SP':44.94,'SQ':20.26,
    'SR':20.26,'SS':20.26,'ST':1.0, 'SV':1.0,  'SW':1.0,  'SY':1.0,
    // ── T ───────────────────────────────────────────────────────────────────
    'TA':1.0, 'TC':1.0,  'TD':1.0,  'TE':20.26,'TF':13.34,'TG':-7.49,'TH':1.0,
    'TI':1.0, 'TK':1.0,  'TL':1.0,  'TM':1.0,  'TN':-14.03,'TP':1.0, 'TQ':-6.54,
    'TR':1.0, 'TS':1.0,  'TT':1.0,  'TV':1.0,  'TW':-14.03,'TY':1.0,
    // ── V ───────────────────────────────────────────────────────────────────
    'VA':1.0, 'VC':1.0,  'VD':-14.03,'VE':1.0, 'VF':1.0,  'VG':-7.49,'VH':1.0,
    'VI':1.0, 'VK':-1.88,'VL':1.0,  'VM':1.0,  'VN':1.0,  'VP':20.26,'VQ':1.0,
    'VR':1.0, 'VS':1.0,  'VT':-7.49,'VV':1.0,  'VW':1.0,  'VY':1.0,
    // ── W ───────────────────────────────────────────────────────────────────
    'WA':-14.03,'WC':1.0,'WD':1.0,  'WE':1.0,  'WF':1.0,  'WG':-9.37,'WH':24.68,
    'WI':1.0, 'WK':1.0,  'WL':13.34,'WM':24.68,'WN':-9.37,'WP':1.0,  'WQ':1.0,
    'WR':1.0, 'WS':1.0,  'WT':-14.03,'WV':-7.49,'WW':1.0, 'WY':1.0,
    // ── Y ───────────────────────────────────────────────────────────────────
    'YA':24.68,'YC':1.0, 'YD':24.68,'YE':1.0,  'YF':1.0,  'YG':-7.49,'YH':13.34,
    'YI':1.0, 'YK':1.0,  'YL':1.0,  'YM':44.94,'YN':1.0,  'YP':13.34,'YQ':1.0,
    'YR':-15.91,'YS':1.0,'YT':-7.49,'YV':1.0,  'YW':-9.37,'YY':13.34
  };

  // Amino acid physicochemical class — for colour coding
  const AA_CLASS = {
    'A':'nonpolar','V':'nonpolar','I':'nonpolar','L':'nonpolar',
    'M':'nonpolar','F':'nonpolar','W':'nonpolar','P':'nonpolar',
    'G':'nonpolar',
    'S':'polar','T':'polar','C':'polar','Y':'polar','N':'polar','Q':'polar',
    'D':'negative','E':'negative',
    'K':'positive','R':'positive','H':'positive'
  };

  const VALID_DNA_CHARS = new Set(['A','T','G','C']);
  const VALID_AA_CHARS  = new Set('ACDEFGHIKLMNPQRSTVWY*'.split(''));

  // ─────────────────────────────────────────────────────────────────────────
  // Sequence utilities
  // ─────────────────────────────────────────────────────────────────────────

  function cleanSequence(input) {
    if (!input || typeof input !== 'string') return '';
    return input.trim().split('\n')
      .filter(l => !l.startsWith('>'))
      .join('').replace(/[\s\d\-\.]/g, '').toUpperCase();
  }

  function parseFASTA(input) {
    if (!input || typeof input !== 'string') return { header: '', sequence: '' };
    const lines  = input.trim().split('\n');
    let header   = '';
    const parts  = [];
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('>')) { header = t.substring(1).trim(); }
      else if (t) { parts.push(t.replace(/[\s\d]/g, '').toUpperCase()); }
    }
    return { header, sequence: parts.join('') };
  }

  /** Reverse-complement a DNA strand */
  function reverseComplement(dna) {
    const comp = { A:'T', T:'A', G:'C', C:'G' };
    return dna.split('').reverse().map(b => comp[b] || 'N').join('');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────────────────

  function validateDNA(sequence) {
    const errors = [];
    if (!sequence || sequence.length === 0) {
      errors.push('The DNA sequence is empty.');
      return { valid: false, errors };
    }
    const badChars = [...new Set(
      sequence.split('').filter(c => !VALID_DNA_CHARS.has(c))
    )];
    if (badChars.length > 0) {
      errors.push(`Invalid nucleotide(s) detected: ${badChars.join(', ')}. Only A, T, G, C are accepted (IUPAC standard bases).`);
    }
    if (sequence.length < 3) {
      errors.push('Sequence must contain at least 3 nucleotides (one codon).');
    }
    if (sequence.length % 3 !== 0) {
      errors.push(`Sequence length (${sequence.length} nt) is not a multiple of 3 — ${sequence.length % 3} trailing nucleotide(s) will be ignored.`);
    }
    return { valid: errors.length === 0, errors };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ORF detection & translation — core fix
  // Scans for the first ATG start codon in the given reading frame and
  // translates until a stop codon or end of sequence is reached.
  // Based on NCBI standard genetic code [1].
  // ─────────────────────────────────────────────────────────────────────────

  /** Translate a clean DNA string starting at position `start` */
  function _translateFrom(dna, start) {
    const aas = [];
    let stopCodon = null;
    let i = start;
    for (; i + 2 < dna.length; i += 3) {
      const codon = dna.substring(i, i + 3);
      const aa = CODON_TABLE[codon];
      if (!aa) { aas.push('X'); }          // ambiguous
      else if (aa === '*') { stopCodon = codon; i += 3; break; }
      else { aas.push(aa); }
    }
    return { protein: aas.join(''), stopCodon, endPos: i };
  }

  /**
   * Find the longest ORF across all 6 reading frames.
   *
   * FIX: replaced `while (i < len) { i = endPos; }` with a proper `for` loop
   * that advances by 3 from each in-frame ATG independently.
   * The old code set `i = endPos` after translating, which skipped every ATG
   * that started INSIDE the previous ORF body — causing nested / overlapping
   * ORFs (very common in real genes) to be silently missed.
   *
   * Scans: 3 forward frames (+1/+2/+3) + 3 reverse-complement frames (-1/-2/-3).
   * Falls back to raw frame-1 forward translation if no ATG is found anywhere.
   */
  function findBestORF(dna) {
    const orfs = [];
    const rc = reverseComplement(dna);

    // Forward frames (+1, +2, +3)
    // Each in-frame position is checked independently → nested ORFs are found.
    for (let frame = 0; frame < 3; frame++) {
      for (let i = frame; i + 2 < dna.length; i += 3) {
        if (dna.substring(i, i + 3) !== 'ATG') continue;
        const startPos = i;
        const { protein, stopCodon, endPos } = _translateFrom(dna, i);
        if (protein.length > 0) {
          orfs.push({ frame: frame + 1, strand: '+', startPos, endPos, protein,
                      stopCodon, hasStop: !!stopCodon });
        }
      }
    }

    // Reverse-complement frames (-1, -2, -3)
    for (let frame = 0; frame < 3; frame++) {
      for (let i = frame; i + 2 < rc.length; i += 3) {
        if (rc.substring(i, i + 3) !== 'ATG') continue;
        const startPos = i;
        const { protein, stopCodon, endPos } = _translateFrom(rc, i);
        if (protein.length > 0) {
          orfs.push({ frame: -(frame + 1), strand: '-', startPos, endPos, protein,
                      stopCodon, hasStop: !!stopCodon });
        }
      }
    }

    if (orfs.length === 0) {
      // No ATG found anywhere — do raw frame-1 translation as last resort
      const { protein, stopCodon } = _translateFrom(dna, 0);
      return { frame: 1, strand: '+', startPos: 0, endPos: dna.length, protein,
               stopCodon, hasStop: !!stopCodon, noATG: true,
               allORFs: [] };
    }
    // Pick the longest ORF; prefer complete (has stop codon) over open-ended
    const complete = orfs.filter(o => o.hasStop);
    const best = (complete.length > 0 ? complete : orfs)
      .sort((a, b) => b.protein.length - a.protein.length)[0];
    return { ...best, allORFs: orfs };
  }

  /**
   * Main translate function.
   * Searches for the longest ORF starting at an ATG codon [1].
   */
  function translate(dnaInput) {
    const clean = cleanSequence(dnaInput);
    const validation = validateDNA(clean);
    const hardErrors = validation.errors.filter(
      e => !e.includes('multiple') && !e.includes('trailing')
    );
    if (hardErrors.length > 0 && clean.length < 3) {
      return { protein: '', length: 0, dna_length: clean.length,
               codons: 0, warnings: validation.errors,
               error: hardErrors[0] };
    }

    const gcContent = computeGC(clean);
    const orf = findBestORF(clean);
    const protein = orf.protein;

    // All frames summary
    const allFrames = (orf.allORFs || []).map(o => ({
      frame: o.frame,
      start: o.startPos + 1,
      length: o.protein.length,
      hasStop: o.hasStop,
      preview: o.protein.substring(0, 20) + (o.protein.length > 20 ? '…' : '')
    }));

    const warnings = [];
    if (orf.noATG) warnings.push('No ATG start codon found — raw frame-1 translation shown.');
    if (!orf.hasStop) warnings.push('No stop codon encountered before the end of the sequence.');
    // Fragment warning: sequences < 100 nt are very likely partial/incomplete genes
    if (clean.length < 100) warnings.push('Sequence is shorter than 100 nt — this is likely a fragment, not a complete gene.');
    validation.errors.filter(e => e.includes('trailing')).forEach(e => warnings.push(e));

    // STRICT statistics: codons = aa + 1 stop (if present); nt = codons × 3.
    // FIX: old code used Math.floor(dna_length / 3) — that counts ALL codons
    // in the full input, NOT just the selected ORF, producing impossible values
    // like "4 aa · 11 codons" for a short embedded ORF in a long DNA input.
    const orfCodons = protein.length + (orf.hasStop ? 1 : 0);
    const orfNt     = orfCodons * 3;
    const orfEnd    = orf.startPos + orfNt;   // 0-based exclusive end position
    // GC content of the ORF subsequence (separate from full-sequence GC)
    const gcOrf = (!orf.noATG && orfNt > 0 && orfEnd <= clean.length)
      ? computeGC(clean.substring(orf.startPos, orfEnd))
      : gcContent;

    return {
      protein,
      length:      protein.length,          // amino acid count
      dna_length:  clean.length,            // total input nucleotides
      orf_codons:  orfCodons,               // ORF codons: aa + stop (if present)
      orf_nt:      orfNt,                   // ORF nucleotides = orf_codons × 3
      codons:      orfCodons,               // backward-compat alias for orf_codons
      orf_start:   orf.startPos + 1,        // 1-based ORF start position
      orf_end:     orfEnd,                  // 0-based end (= last ORF nt + 1)
      orf_frame:   orf.frame,
      has_stop:    orf.hasStop,
      stop_codon:  orf.stopCodon || null,
      gc_content:  gcContent,               // full input DNA GC%
      gc_orf:      gcOrf,                   // ORF-region-only GC%
      is_fragment: clean.length < 100,
      all_frames:  allFrames,
      warnings
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GC content — [8]
  // ─────────────────────────────────────────────────────────────────────────
  function computeGC(dna) {
    if (!dna || dna.length === 0) return 0;
    const gc = (dna.match(/[GC]/g) || []).length;
    return parseFloat(((gc / dna.length) * 100).toFixed(1));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Molecular weight — [2] ExPASy ProtParam method
  // MW = Σ residue weights + 18.02 (terminal H₂O)
  // ─────────────────────────────────────────────────────────────────────────
  function computeMW(seq) {
    if (!seq) return 0;
    let mw = 18.02;
    for (const aa of seq) { mw += RESIDUE_WEIGHTS[aa] || 111.1; }
    return mw;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Isoelectric point (pI) — iterative bisection, Bjellqvist [3]
  // ─────────────────────────────────────────────────────────────────────────
  function computePI(seq) {
    if (!seq || seq.length === 0) return null;
    const count = aa => (seq.match(new RegExp(aa, 'g')) || []).length;
    const nD = count('D'), nE = count('E'), nH = count('H');
    const nC = count('C'), nY = count('Y'), nK = count('K'), nR = count('R');

    function charge(pH) {
      const f = (pK, n, sign) =>
        sign * n / (1 + Math.pow(10, sign * (pH - pK)));
      return (
        f(PKA.Nterm, 1,  1) +
        f(PKA.K,     nK,  1) +
        f(PKA.R,     nR,  1) +
        f(PKA.H,     nH,  1) +
        f(PKA.D,     nD, -1) +
        f(PKA.E,     nE, -1) +
        f(PKA.C,     nC, -1) +
        f(PKA.Y,     nY, -1) +
        f(PKA.Cterm, 1, -1)
      );
    }

    let lo = 0, hi = 14;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (charge(mid) > 0) lo = mid; else hi = mid;
    }
    return parseFloat(((lo + hi) / 2).toFixed(2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GRAVY (Grand Average of Hydropathicity) — Kyte & Doolittle [4]
  // ─────────────────────────────────────────────────────────────────────────
  function computeGRAVY(seq) {
    if (!seq || seq.length === 0) return null;
    const sum = seq.split('').reduce((s, aa) => s + (HYDROPHOBICITY[aa] || 0), 0);
    return parseFloat((sum / seq.length).toFixed(3));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Extinction coefficient at 280 nm — Pace et al. [5]
  // ε₂₈₀ = nW × 5500 + nY × 1490 + nC × 125  (M⁻¹cm⁻¹)
  // ─────────────────────────────────────────────────────────────────────────
  function computeExtinction(seq) {
    if (!seq) return 0;
    const nW = (seq.match(/W/g) || []).length;
    const nY = (seq.match(/Y/g) || []).length;
    const nC = (seq.match(/C/g) || []).length;
    return nW * 5500 + nY * 1490 + nC * 125;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Instability index — Guruprasad et al. [6]
  // II = (10 / n) × Σ DIWV(xi, xi+1)
  // Protein is unstable if II > 40
  // ─────────────────────────────────────────────────────────────────────────
  function computeInstability(seq) {
    if (!seq || seq.length < 2) return null;
    let sum = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      const pair = seq[i] + seq[i + 1];
      sum += INSTABILITY_MATRIX[pair] || 0;
    }
    return parseFloat(((10 / seq.length) * sum).toFixed(2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Aliphatic index — Ikai [7]
  // AI = Ala + 2.9 × Val + 3.9 × (Ile + Leu)
  // ─────────────────────────────────────────────────────────────────────────
  function computeAliphatic(seq) {
    if (!seq || seq.length === 0) return null;
    const n = seq.length;
    const nA = (seq.match(/A/g)||[]).length / n * 100;
    const nV = (seq.match(/V/g)||[]).length / n * 100;
    const nI = (seq.match(/I/g)||[]).length / n * 100;
    const nL = (seq.match(/L/g)||[]).length / n * 100;
    return parseFloat((nA + 2.9 * nV + 3.9 * (nI + nL)).toFixed(2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Protein validation
  // ─────────────────────────────────────────────────────────────────────────

  function validateProtein(sequence) {
    if (!sequence) return false;
    for (const ch of sequence) { if (!VALID_AA_CHARS.has(ch)) return false; }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // In-memory LRU-style memoization for heavy per-sequence computations.
  // Max 500 entries; evicts the oldest 100 when the limit is reached.
  // ─────────────────────────────────────────────────────────────────────────
  const _statsCache = new Map();
  const _CACHE_MAX  = 500;
  const _EVICT_N    = 100;

  function _statsFromCache(seq) {
    return _statsCache.has(seq) ? _statsCache.get(seq) : null;
  }

  function _setStatsCache(seq, val) {
    if (_statsCache.size >= _CACHE_MAX) {
      // Evict the oldest entries (Map preserves insertion order)
      let evicted = 0;
      for (const k of _statsCache.keys()) {
        _statsCache.delete(k);
        if (++evicted >= _EVICT_N) break;
      }
    }
    _statsCache.set(seq, val);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Comprehensive protein statistics — all formulas cited above
  // ─────────────────────────────────────────────────────────────────────────
  function proteinStats(sequence) {
    if (!sequence || sequence.length === 0) return null;

    // Return memoized result when available
    const cached = _statsFromCache(sequence);
    if (cached) return cached;

    // Composition
    const composition = {};
    for (const aa of sequence) {
      composition[aa] = (composition[aa] || 0) + 1;
    }

    // Class composition
    const classCount = { nonpolar: 0, polar: 0, positive: 0, negative: 0 };
    for (const aa of sequence) {
      const cls = AA_CLASS[aa];
      if (cls) classCount[cls]++;
    }

    const mw         = computeMW(sequence);
    const pI         = computePI(sequence);
    const gravy      = computeGRAVY(sequence);
    const extinction = computeExtinction(sequence);
    const instIdx    = computeInstability(sequence);
    const aliIdx     = computeAliphatic(sequence);

    // Absorption (A0.1% at 280 nm)
    const abs01 = extinction > 0 ? parseFloat((extinction / mw).toFixed(3)) : null;

    const result = {
      length: sequence.length,
      molecular_weight: mw,
      molecular_weight_kda: parseFloat((mw / 1000).toFixed(2)),
      pI,
      gravy,
      extinction_coefficient: extinction,
      abs_01pct: abs01,
      instability_index: instIdx,
      is_stable: instIdx !== null ? instIdx < 40 : null,
      aliphatic_index: aliIdx,
      composition,
      class_composition: classCount
    };

    _setStatsCache(sequence, result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Colour-coded HTML for sequence display
  // ─────────────────────────────────────────────────────────────────────────
  function sequenceToHTML(seq, groupSize = 10) {
    if (!seq) return '';
    const classMap = {
      nonpolar: 'aa-nonpolar', polar: 'aa-polar',
      positive: 'aa-positive', negative: 'aa-negative'
    };
    let html = '';
    for (let i = 0; i < seq.length; i++) {
      if (i > 0 && i % groupSize === 0) html += ' ';
      const aa  = seq[i];
      const cls = classMap[AA_CLASS[aa]] || '';
      html += `<span class="${cls}" title="${AA_NAMES[aa] || aa}">${aa}</span>`;
    }
    return html;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Six-frame translation — ExPASy Translate-style
  // Mirrors: https://web.expasy.org/translate/
  // ─────────────────────────────────────────────────────────────────────────

  /** Translate a DNA strand in a single specified reading frame (no ORF detection). */
  function translateFrameFull(dna, offset) {
    let aaSeq = '';
    for (let i = offset; i + 2 < dna.length; i += 3) {
      const codon = dna.substring(i, i + 3);
      aaSeq += CODON_TABLE[codon] || 'X';
    }
    // Count complete ORFs (ATG … stop)
    let orfCount = 0, inORF = false;
    for (const aa of aaSeq) {
      if (!inORF && aa === 'M') { inORF = true; orfCount++; }
      if (inORF  && aa === '*') { inORF = false; }
    }
    return {
      protein:    aaSeq,
      length:     aaSeq.length,
      stopCount:  (aaSeq.match(/\*/g) || []).length,
      startCount: (aaSeq.match(/M/g)  || []).length,
      orfCount
    };
  }

  /**
   * Translate a DNA sequence in all 6 reading frames.
   * Returns 6 frame objects: +1 / +2 / +3 (forward) then -1 / -2 / -3 (RC).
   */
  function translateAllSixFrames(dnaInput) {
    const dna = cleanSequence(dnaInput);
    if (!dna || dna.length < 3) return [];
    const rc = reverseComplement(dna);
    const frames = [];
    for (let off = 0; off < 3; off++) {
      frames.push({ label: `+${off + 1}`, strand: '+', frame: off + 1, offset: off,
                    ...translateFrameFull(dna, off), dnaLength: dna.length });
    }
    for (let off = 0; off < 3; off++) {
      frames.push({ label: `-${off + 1}`, strand: '-', frame: off + 1, offset: off,
                    ...translateFrameFull(rc,  off), dnaLength: dna.length });
    }
    return frames;
  }

  /**
   * ExPASy-style colour-coded HTML for a reading frame sequence.
   * Renders numbered lines (60 aa / line, groups of 10) with ORF regions
   * (M … *) highlighted via a coloured background span.
   *
   * @param {string} seq      - amino acid string (may contain * and M)
   * @param {string} orfColor - CSS background colour for ORF regions
   * @param {number} lineLen  - residues per display line (default 60)
   */
  function frameSequenceToHTML(seq, orfColor, lineLen, groupSize) {
    if (!seq) return '';
    orfColor  = orfColor  || 'rgba(16,185,129,0.15)';
    lineLen   = lineLen   || 60;
    groupSize = groupSize || 10;

    const classMap = {
      nonpolar: 'aa-nonpolar', polar: 'aa-polar',
      positive: 'aa-positive', negative: 'aa-negative'
    };

    // Mark each position as inside an ORF (M … * inclusive)
    const inOrf = new Uint8Array(seq.length);
    let orfOpen = false;
    for (let i = 0; i < seq.length; i++) {
      if (!orfOpen && seq[i] === 'M') orfOpen = true;
      if (orfOpen) {
        inOrf[i] = 1;
        if (seq[i] === '*') orfOpen = false;
      }
    }

    let html = '';
    for (let lineStart = 0; lineStart < seq.length; lineStart += lineLen) {
      const lineEnd = Math.min(lineStart + lineLen, seq.length);
      const pos     = lineStart + 1;
      html += '<span class="aa-pos">' + String(pos).padStart(6, '\u00a0') + '</span> ';

      for (let i = lineStart; i < lineEnd; i++) {
        if (i > lineStart && (i - lineStart) % groupSize === 0) html += ' ';
        const aa  = seq[i];
        const bg  = inOrf[i] ? ' style="background:' + orfColor + ';border-radius:2px"' : '';
        if      (aa === '*') html += '<span class="aa-stop"    title="Stop codon"' + bg + '>*</span>';
        else if (aa === 'M') html += '<span class="aa-start"   title="Methionine \u2014 ORF start"' + bg + '>M</span>';
        else if (aa === 'X') html += '<span class="aa-unknown" title="Ambiguous codon">X</span>';
        else {
          const cls = classMap[AA_CLASS[aa]] || '';
          html += '<span class="' + cls + '" title="' + (AA_NAMES[aa] || aa) + '"' + bg + '>' + aa + '</span>';
        }
      }
      html += '\n';
    }
    return html;
  }

  // One-letter → full amino acid names
  const AA_NAMES = {
    A:'Alanine',R:'Arginine',N:'Asparagine',D:'Aspartate',C:'Cysteine',
    E:'Glutamate',Q:'Glutamine',G:'Glycine',H:'Histidine',I:'Isoleucine',
    L:'Leucine',K:'Lysine',M:'Methionine',F:'Phenylalanine',P:'Proline',
    S:'Serine',T:'Threonine',W:'Tryptophan',Y:'Tyrosine',V:'Valine'
  };

  // ─────────────────────────────────────────────────────────────────────────
  return {
    cleanSequence, parseFASTA, reverseComplement,
    validateDNA, validateProtein,
    translate, findBestORF,
    translateFrameFull, translateAllSixFrames, frameSequenceToHTML,
    proteinStats, computeMW, computePI, computeGRAVY,
    computeExtinction, computeInstability, computeAliphatic, computeGC,
    sequenceToHTML,
    CODON_TABLE, HYDROPHOBICITY, AA_CLASS, AA_NAMES
  };
})();
