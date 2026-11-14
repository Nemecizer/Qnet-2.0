# Qnet display-precision filter. argv[0] = fraction digits (0-9).
# Runs as the LAST stage of the run wrapper's pipeline, after `tee`,
# so the archived run output the result parser reads keeps every digit
# the solver printed and only the terminal is normalized.
use strict; use warnings;
$| = 1;
my $D = defined $ARGV[0] ? $ARGV[0] + 0 : 6;
$D = 0 if $D < 0;
$D = 9 if $D > 9;
# Below 10^-D a fixed format would print "0.000" for a nonzero value,
# so switch to scientific with one digit fewer than asked (never < 1).
# At D = 0 there is no such fallback: the user asked for whole numbers and
# DS.Number.display makes the same call, and these two must never disagree.
my $E = $D - 1 < 1 ? 1 : $D - 1;
# Spelled as the decimal literal "1e-<D>", not as 10 ** -$D: the
# boundary test below compares against it for EQUALITY, and the value a
# rounded token like "1.00000e-06" parses to is the nearest double to
# the literal. pow() is free to land one ulp away from that.
my $T = $D > 0 ? ("1e-" . $D) + 0 : 0;
# Symmetric upper guard. Without it 3.456789e+20 renders as
# 345678899999999983616.000 — twenty digits of floating-point noise the
# solver never computed, in a field sized for eight characters. fmt7 in
# buildComparisonAwk uses the same threshold so the two agree.
my $U = 1e9;

# Reformat one number. Three rules, in order of how much damage getting them
# wrong does:
#
#   1. Never invent digits. A token that arrived in scientific notation keeps
#      that notation and never gains mantissa digits: the solver printed
#      4.567e-09 because four significant figures is what it can defend, and
#      4.56700e-09 claims two it never computed. This is also what makes the
#      filter idempotent over fmt7's own scientific fallback.
#   2. Never move a column's left edge. `$pad` is the whitespace the token
#      arrived behind. A replacement that is SHORTER is right-aligned inside
#      the original token width, so a right-aligned %10.4f column keeps its
#      decimal points stacked; a replacement that is LONGER simply takes the
#      room it needs and the line grows to the right. Reclaiming leading
#      spaces (the previous behaviour) shifted the value out from under its
#      header and — because how much could be reclaimed depended on the
#      value's own width — sheared rows against each other.
#   3. Never pad a number that is not in a column. A column is produced by a
#      printf field, so the character in front of its leading whitespace is
#      a digit or a header word. A number introduced by '=', ':' or ',' is
#      prose — `generator residual = 4.11409192216e-13`,
#      `mean_number_in_system: 0.98283912`, `[0.88368701, 1.0819912]` — and
#      right-aligning a shorter replacement inside the original token width
#      wedged up to eleven spaces into those sentences at the DEFAULT
#      setting. Prose keeps the spacing the solver printed, exactly: no
#      padding taken, and no column debt repaid out of it either.
#   4. Pay a longer replacement back out of the NEXT gap, so the column
#      after it starts where the solver's printf put it. See `$debt`.
#   5. Never pad the ONLY number on a record when it is standing one
#      space behind its neighbour. Rule 3 catches prose that announces
#      itself with '=', ':' or ',', and that is most of it; what it
#      cannot see is a sentence with no introducer at all —
#      `[Parse] 0.000 s`, `[Total] 0.155 s`, and the `effective cycles
#      4345.2` clause of a regenerative line whose only other numbers
#      are bare integers this pattern does not match. Right-aligning
#      those inside their old width wedged four spaces into each one at
#      0 decimal places. A printf field, by contrast, leaves SLACK in
#      front of its value, and a table row carries a row of values: one
#      field behind one space is what says "sentence".
#      Both halves are load-bearing, and each is wrong on its own — a
#      bare field count un-pads rbm_mlmc.c:1127's genuine one-column
#      `#   %-16s  %10.6f` table, and a bare pad test un-pads any column
#      whose widest value happens to fill its own field. Measured over
#      every example every solver in the tree ships: the rule fires on
#      17 records, all seventeen of them prose, and on no row of any
#      table at any of the seven reachable settings.

# Characters the previous replacement on this record grew by and has not
# yet paid back.
#
# Rule 2 lets a longer replacement take the room it needs, which is right
# for the value but pushes every column to its right — srbm_output.c
# prints `  E[Z_%d^k]    ` headers (srbm_output.c:136) over `  %12.6f`
# fields (:142), and that table keeps its rows mutually aligned at
# display precision 6 but slides them out from under their own headings.
# (An earlier version of this comment cited `%-11s` over `%-11.4f` in
# rbm_mlmc and srbm_output; neither file contains that format. The
# right-aligned table above is the real one, and rbm_mlmc.c:1221's
# `#   %-16s  W = %10.6f` is the other.) The gap the printf left after
# the field is exactly the slack that growth should come out of, so it
# is taken from the NEXT token's leading pad instead of from the line's
# total width.
#
# Growth is set by the field's own printf precision, not by the value, so
# every row of a column grows by the same amount and repays the same
# amount: rows stay aligned with each other, which is the property round
# 1 established and the one this must not cost. One space always
# survives, so two columns can never fuse into a single token; and a gap
# of a single space — prose, and `k = v` pairs — can pay nothing, which
# is what keeps a sentence from being re-spaced.
#
# The residual, stated plainly: repayment is capped by the gap the printf
# left, and a value can outgrow its whole field. `%-11.4f` grows by
# D - 4, so at the shipped D = 6 every plausible value still fits its
# eleven columns and the table lands exactly under its headers; at D = 9
# a row holding `123.4567` cannot repay in full and ends one or two
# characters right of its neighbours. That is a strictly smaller defect
# than the alternative it replaced, where at D = 9 *every* column of
# *every* row sat up to twenty characters away from its own heading —
# but it is a real one, and it is why the fix belongs here rather than
# in a widened header that would drift by the same amount.
my $debt = 0;

# $prose is true when the token is introduced by '=', ':' or ',' (see rule
# 3), or when it is a sentinel's key=value field. A prose token neither
# takes padding nor repays column debt: whatever spacing the solver put
# around it survives byte for byte.
#
# Prose is sticky to the end of the record. An introducer identifies the
# LINE as a sentence, not just the one token behind it: srbm_lp's
# parameter echo prints a space-separated pair per key
# (`  drift         = -1.0000 0.0000`), and regenerative MC writes a whole
# clause (`mean_number_in_system: 9.09 (sequential interval [7.30, 10.88];
# effective cycles 5442.3)`). Exempting only the first value left every
# later one right-aligned inside its original width, which is the same
# stray-space defect one token further along the same sentence. A printf
# table row carries no '=', ':' or ',' ahead of its columns, so the flag
# cannot be raised on one.
my $prose_run = 0;
sub prose_flag {
    $prose_run = 1 if $_[0];
    return $prose_run;
}
sub fmtnum {
    my ($pad, $tok, $prose, $lone) = @_;
    if (!$prose && $debt > 0 && length($pad) > 1) {
        my $pay = length($pad) - 1;
        $pay = $debt if $debt < $pay;
        $pad = substr($pad, $pay);
        $debt -= $pay;
    }
    my $v = $tok + 0;
    # %+ keeps a deliberately signed column (fBNAsm's drift b_i is printed
    # %+8.5f so the sign carries the stability verdict) reading as one format.
    my $plus = substr($tok, 0, 1) eq '+' ? '+' : '';
    my $out;
    # Notation follows the VALUE, not the spelling the solver chose, so
    # that this agrees with awk fmt7 and DS.Number.display for every input
    # (the one exception is the exact-threshold tie below). Deciding it on
    # /[eE]/ meant `Optimal u* = 0.0000000000e+00` (srbm_lp prints %.10e)
    # stayed `0.00000e+00` in the Shell while the same zero read
    # `0.000000` in the Results pane, at the shipped default.
    my $sci = ($v != 0 && (abs($v) < $T || abs($v) >= $U)) ? 1 : 0;
    # Boundary hysteresis, and the ONLY place the token's spelling is
    # allowed back into the notation decision.
    #
    # fmt7 and DS.Number.display choose from the exact value; this
    # filter only ever sees the ROUNDED token, and rounding can carry a
    # value across the very threshold that chose its notation:
    #   * fmt7 sees 9.999996e-07 at D = 6, takes the scientific branch
    #     because it is below 10^-6, and prints "1.00000e-06" — whose
    #     value IS 10^-6. Read back, that is inside the fixed band, so
    #     the filter rewrote fmt7's own cell as "0.000001": a different
    #     notation, in a column awk had already sized.
    #   * symmetrically, %.3f of 999999999.9999 is "1000000000.000",
    #     which reads back as exactly 1e9 and flipped to "1.00e+09".
    # At exactly the threshold the two readings are indistinguishable
    # from the value alone, so the tie goes to the notation the token
    # already carries — but ONLY when the token is byte-identical to what
    # fmt7/DS.Number.display would have written for that value at this
    # setting. That narrowness is the point: `1.00000e-06` at D = 6 is
    # fmt7's own cell and is left alone, while a solver's own `1e-06` or
    # `1.0000000000000001e-06` is not fmt7's output and still normalizes
    # to `0.000001` like every other value in the fixed band. So the
    # spelling decides nothing except "this cell has already been
    # formatted by the formatter I am required to agree with".
    if (!$sci && $D > 0 && abs($v) == $T
        && $tok eq sprintf("%$plus.*e", $E, $v)) { $sci = 1 }
    if ($sci && abs($v) == $U
        && $tok eq sprintf("%$plus.*f", $D, $v)) { $sci = 0 }
    if ($sci) {
        # Rule 1 still holds inside the scientific band: a token that
        # arrived scientific never gains mantissa digits, which is also
        # what makes the filter idempotent over fmt7's own fallback.
        my $digits = $E;
        if ($tok =~ /[eE]/) {
            my ($mantissa) = ($tok =~ /\A([^eE]*)/);
            my $have = ($mantissa =~ /\.(\d+)\z/) ? length($1) : 0;
            $digits = $have if $have < $E;
        }
        $out = sprintf("%$plus.*e", $digits, $v);
    } else {
        $out = sprintf("%$plus.*f", $D, $v);
    }
    # A displayed "-0.000000" reads as a sign error, not as a small negative.
    $out =~ s/\A-(0(?:\.0+)?)\z/$1/;
    my $lo = length($out);
    my $lt = length($tok);
    return $pad . $out if $prose;
    # Rule 5 (see $FIELD_RE): the ONLY number on the record, standing
    # one space behind whatever precedes it, is prose too. `$lone` is
    # the record-wide field count, `$pad` the separation; a printf that
    # laid this number out in a column left slack in front of it, and a
    # sentence left a single space. Both halves are load-bearing:
    # dropping the count would un-pad rbm_mlmc.c:1127's genuine
    # single-column `#   %-16s  %10.6f` table, and dropping the pad test
    # would un-pad a one-column row whose neighbours are integers.
    return $pad . $out if $lone && length($pad) < 2;
    # A column token still grows the line rather than borrowing from a gap
    # that does not exist; the debt is recorded so a table whose first
    # column is flush left still repays out of the second gap.
    $debt += $lo - $lt if $lo > $lt;
    return $out if length($pad) == 0;
    return $pad . (' ' x ($lt - $lo)) . $out if $lo < $lt;
    return $pad . $out;
}

# The one pattern that finds every number this filter may rewrite, and
# the only place its shape is written down. Each record runs it TWICE —
# once to count the fields, once to rewrite them — and sharing the qr//
# is what guarantees the two passes agree about what a number is. Two
# hand-copied regexes that drifted apart would let a token be padded as
# a column while the count had already called the record prose.
my $FIELD_RE = qr{
    (\e\[[0-?]*[ -\/]*[@-~])
  | ([=:,]?)(\ *)(?<![\w.\@\/])([+-]?(?:\d+\.\d+|\.\d+|\d+(?=[eE]))(?:[eE][+-]?\d+)?)(?![\w%\/])(?!\.\S)
}x;

sub emit {
    my ($rec) = @_;
    # Column debt is a property of one printed line. A record boundary
    # ends the row, so it ends the debt too.
    $debt = 0;
    $prose_run = 0;
    # Machine sentinels are contracts, and most of them accompany a
    # report rather than replace it. Skipping the whole record left
    # `estimate=1.9999999999722793` on screen at every setting, so a
    # record that IS shown is rewritten here.
    #
    # So the record is rewritten, but far more conservatively than prose:
    # only a token that is the COMPLETE value of one of the NAMED
    # float-bearing keys below, followed by whitespace or the end of the
    # record. The head, every key, every integer-valued field (level=,
    # iterations=, exit=, cap_hits=) and every percent-encoded string
    # (value=M%2FM%2F1) are byte-identical because they are not on the
    # list. No padding is applied, ever.
    #
    # This is display only. ResultOutputParser and the CSV export read the
    # tee'd file, which is written by the pipeline stage BEFORE this one
    # and still holds every digit the solver printed.
    # Two sentinel classes a reader never needs to see, because the
    # solver that writes them now prints the same numbers as a report
    # directly above them.
    #
    # Regenerative Monte Carlo prints a per-node table and a
    # confidence-interval table, so its QNET_NODE_METRIC_V1 records were
    # the same values a second time at 17 significant digits — ten
    # key=value pairs per node per metric. Exact Matrix-Analytic QBD used
    # to print QNET_QBD_*_V1 records and NOTHING else, which is why this
    # was once a single-class rule; qbd_solver.py format_human now leads
    # with a report, so the records are duplicate here too — and they
    # carried the last percent-encoded prose on screen
    # (`value=M%2FM%2F1`).
    #
    # Both are still WRITTEN, because ResultOutputParser and the CSV
    # export read them out of the tee'd archive that this stage never
    # touches; they are only withheld from the screen. Still NOT
    # generalised to every sentinel — QNET_METHOD_FAILURE_V1 and
    # QNET_MLMC_STATUS_V1 are the only report of what they report.
    if ($rec =~ /\AQNET_(?:NODE_METRIC|QBD_(?:METRIC|EVIDENCE|ERROR))_V1(?![A-Za-z0-9_])/) {
        return;
    }
    if ($rec =~ /\AQNET_[A-Z0-9_]+_V1(?![A-Za-z0-9_])/) {
        # The key list, not the spelling of the value. A syntactic rule
        # ("any '='-preceded token carrying a decimal point or an
        # exponent") skips a float-bearing field whose value happens to
        # land on an exact integer, and then the SAME quantity appears
        # twice on adjacent lines in two spellings:
        #   QNET_NODE_METRIC_V1 ... estimate=1 ci_low=1 ci_high=1
        #   QNET_NODE_METRIC_V1 ... estimate=0.900000 ci_low=0.880000
        # (both classes below are withheld from the screen today, but the
        # rule governs every sentinel that is shown, and an exact-integer
        # measurement is not rare)
        # Naming the keys instead is what makes `estimate=1.000000`,
        # `standard_error=0.000000` and `ci_low=1.000000` come out at the
        # configured precision like every other measurement.
        #
        # Every other field of every sentinel is left byte-identical by
        # construction, because it is not on this list: metric=, level=,
        # node_id=, class_id=, iterations=, cap_hits=, exit=,
        # successful=, fallback_used=.
        #
        # Known, deliberate, and NOT a bug to re-derive next round: the
        # same exact-integer case in PROSE is still left at the solver's
        # own spelling. `external_blocking_probability: 0` sits beside
        # `departure_rate: 0.999550` in regenerative MC's human lines
        # because a prose token carries no key to consult, and there the
        # bare integer is as likely to be a count (`Complete
        # empty-to-empty cycles: 20000`, `iterations`, a station index)
        # as a measurement. Rewriting every bare integer in prose would
        # break the one guarantee this filter is built on — that a count
        # never gains a decimal point. The honest fix is solver-side: the
        # handful of human-output writers that print a measurement with
        # %g (regenerative_mc.py, truncated_ctmc.py, product_form) should
        # print measurements with an explicit fixed format so they always
        # carry a point.
        my $float_key = qr/estimate|standard_error|ci_confidence
                          |ci_low|ci_high|ci_half_width|effective_cycles/x;
        my $num = qr/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
        $rec =~ s{
            (?<![A-Za-z0-9_])($float_key=)($num)(?=[\s;,]|\z)
        }{ $1 . fmtnum('', $2, 1, 0) }gex;
        # There was a second rewrite here, for QNET_QBD_EVIDENCE_V1's
        # `value=` field, whose contents are a number for some keys and a
        # percent-encoded string for others. It is gone because the whole
        # QBD class is suppressed above: unreachable code that still
        # looked like a live rule about how values are formatted.
    } else {
        # Branch 1 consumes ANSI escapes untouched. Branch 2 rewrites a
        # token that carries a decimal point, and — only when an exponent
        # follows — a bare integer mantissa, so that a line printing both
        # "1e-9" and "6.02e23" does not come out in two spellings. Plain
        # counts, indices, seeds and exit codes carry neither and stay out
        # of scope by construction.
        #
        # The look-around keeps "S1.2", version "0.90.34" and
        # "/tmp/x_3.4.sh" whole; '/' and '@' additionally keep a path or a
        # formula out of it ("python@3.11/lib" must not become
        # "python@3.110/lib" in a diagnostic the user is about to copy);
        # and excluding a trailing '%' leaves the comparison table's
        # (+1.2%) delta at exactly the width awk computed its column
        # widths for. A following '.' disqualifies a token only when
        # something non-blank follows the '.' as well — that is what
        # separates the middle of "0.90.34" from the end of the sentence
        # "the utilisation is 0.5.", which used to be the one number in a
        # paragraph left at the solver's own precision.
        #
        # Two known, currently unreachable hazards, recorded here so the
        # next person adding a diagnostic line knows them. (1) A
        # TWO-component version or identifier in prose is a decimal
        # number to this regex: "Python 3.11" would become
        # "Python 3.110000". Three components are safe — the trailing-dot
        # guard catches "0.90.34" — and no normalized run path prints a
        # two-component version today (the GJN/MCN/bnetio banners sit
        # behind -v flags the app never passes). (2) A number written
        # immediately after an ANSI escape is never rewritten: branch 1
        # consumes the escape, and the look-behind then sees the CSI's
        # terminating letter and refuses. No solver colours a value
        # today; one that starts to would opt out of the setting in
        # silence.
        #
        # The optional [=:,] prefix is captured and re-emitted verbatim;
        # its only job is to tell fmtnum that this number is introduced by
        # a sentence rather than laid out by a printf field (rule 3).
        # Rule 5's field count, taken before anything is rewritten:
        # how many tokens on THIS record fmtnum is about to see. A
        # printf table row carries a whole row of them; a sentence with
        # a measurement in it carries one.
        my $fields = 0;
        {
            my $scan = $rec;
            while ($scan =~ /$FIELD_RE/g) { $fields++ if defined $4 }
        }
        $rec =~ s{$FIELD_RE}{
            defined $1 ? $1
                       : $2 . fmtnum($3, $4, prose_flag(length($2) > 0),
                                     $fields < 2 ? 1 : 0)
        }ge;
    }
    print $rec;
}

# Record-at-a-time, CR-aware and unbuffered. The progress bar and spinner
# redraw with \r and emit no newline until the run ends, so a line-oriented
# filter would swallow every intermediate frame: split after \r as well as
# \n, and release an unterminated tail once the pipe has been idle for a
# tick.
#
# `holding` is the safety interlock on that release. A tail is held when
# letting it go could change a number:
#   * it could still grow into a QNET_ sentinel, whose body must pass through
#     byte for byte; or
#   * it ends inside a numeric token. A solver that pauses mid-buffer — every
#     spinner-wrapped run does, and so does any convergence trace — can split
#     `0.666666` into `0.66` and `6666`. Formatting the first half and then
#     printing the second produced `0.6606666`: a wrong number, on screen, in
#     the pane this release makes the centrepiece. The trailing-character test
#     is exact rather than heuristic, because a split inside a numeric token
#     always leaves the buffer ending in one of its characters.
# Holding is unbounded, not one tick: the release branch simply does not fire
# while `holding()` is true, so a tail that stops growing stays held until
# more bytes arrive. Nothing reachable stalls on it — every progress frame
# ends in `s` and every result line in a newline — but a future solver that
# paused mid-number with nothing further to write would leave that fragment
# on screen only when the run ended. Releasing early instead prints a value
# that is not the solver's, which is the worse of the two.
my $rin = '';
vec($rin, fileno(STDIN), 1) = 1;
my $buf = '';
sub holding {
    return 0 unless length $buf;
    return 1 if $buf =~ /\AQNET_/ || "QNET_" =~ /\A\Q$buf\E/;
    return 1 if $buf =~ /[0-9.eE+-]\z/;
    return 0;
}
while (1) {
    my $timeout = length($buf) ? 0.05 : undef;
    my $ready = select(my $rout = $rin, undef, undef, $timeout);
    if (defined $ready && $ready > 0) {
        my $chunk = '';
        my $n = sysread(STDIN, $chunk, 65536);
        if (!defined $n) { next if $!{EINTR}; last }
        last if $n == 0;
        $buf .= $chunk;
        while ($buf =~ s/\A([^\r\n]*[\r\n])//) { emit($1) }
    } elsif (!holding()) {
        emit($buf) if length $buf;
        $buf = '';
    }
}
emit($buf) if length $buf;