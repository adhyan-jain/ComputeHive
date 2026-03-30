package store

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type respValue struct {
	kind  byte
	text  string
	bulk  []byte
	array []respValue
	nil   bool
}

func (v respValue) String() string {
	if v.kind == '$' {
		return string(v.bulk)
	}

	return v.text
}

func writeCommand(writer io.Writer, args []string) error {
	if _, err := fmt.Fprintf(writer, "*%d\r\n", len(args)); err != nil {
		return err
	}

	for _, arg := range args {
		if _, err := fmt.Fprintf(writer, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}

	return nil
}

func readReply(reader *bufio.Reader) (respValue, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return respValue{}, err
	}

	switch prefix {
	case '+':
		line, err := readLine(reader)
		if err != nil {
			return respValue{}, err
		}
		return respValue{kind: '+', text: line}, nil
	case '-':
		line, err := readLine(reader)
		if err != nil {
			return respValue{}, err
		}
		return respValue{}, errors.New(line)
	case ':':
		line, err := readLine(reader)
		if err != nil {
			return respValue{}, err
		}
		return respValue{kind: ':', text: line}, nil
	case '$':
		line, err := readLine(reader)
		if err != nil {
			return respValue{}, err
		}
		length, err := strconv.Atoi(line)
		if err != nil {
			return respValue{}, err
		}
		if length == -1 {
			return respValue{kind: '$', nil: true}, nil
		}

		buffer := make([]byte, length+2)
		if _, err := io.ReadFull(reader, buffer); err != nil {
			return respValue{}, err
		}
		return respValue{kind: '$', bulk: buffer[:length]}, nil
	case '*':
		line, err := readLine(reader)
		if err != nil {
			return respValue{}, err
		}
		length, err := strconv.Atoi(line)
		if err != nil {
			return respValue{}, err
		}
		if length == -1 {
			return respValue{kind: '*', nil: true}, nil
		}

		items := make([]respValue, 0, length)
		for range length {
			item, err := readReply(reader)
			if err != nil {
				return respValue{}, err
			}
			items = append(items, item)
		}

		return respValue{kind: '*', array: items}, nil
	default:
		return respValue{}, fmt.Errorf("unsupported redis reply prefix %q", prefix)
	}
}

func readLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}

	return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), nil
}
